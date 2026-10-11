<#
  remote-agent.ps1 - the helper that runs INSIDE the logged-in Remote Desktop session of the remote host.

  *********************************************************************************************************
  *** NOT VERIFIED on a real Windows host. This script was written and reviewed on macOS, where there   ***
  *** is no PowerShell and no Windows: it has never been executed, not even by a PowerShell parser.     ***
  *** Everything the TypeScript side guarantees is tested against a TypeScript stand-in agent; this     ***
  *** file is kept in step with it by tests/remoteProtocol.spec.ts (names only - not behaviour).        ***
  *** The first run on a real host is the verification: read agent\agent.log, then run                  ***
  *** "automation-remote check".                                                                        ***
  *********************************************************************************************************

  What it does: polls <root>\requests for request files, runs each one on this host (which can reach the
  database, the APIs and SAP GUI) and writes <root>\responses\<id>.json. <root> is the parent of the folder
  this script is in - the test machine's mailbox folder, redirected into the session as \\tsclient\<L>.
  The wire contract (folder layout, request and response shape, error codes) is src/remote/protocol.ts.

  Requirements: Windows PowerShell 5.1 (no modules, nothing to install), started in the interactive RDP
  session (the `alternate shell` of the .rdp file, a Startup-folder entry, or agent\start.cmd).

  Safety: it only reads and writes inside <root>; it honours the allow list in agent\config.json (http, db,
  sap, exec - answered with DENIED otherwise); it never writes request bodies, SQL, headers or connection
  strings to agent.log; error texts are scrubbed of password=... pairs before they leave this script.
#>

$ErrorActionPreference = 'Stop'

# ---- constants (the wire contract; see src/remote/protocol.ts) --------------------------------------------
$AgentVersion = '1.0.0'
$ProtocolVersion = 1
$MaxRequestAgeSeconds = 600
$MaxOutputChars = 1048576
$DefaultMaxRows = 10000
$MaxLogBytes = 1048576

$Root = Split-Path -Parent $PSScriptRoot
$RequestsDir = Join-Path $Root 'requests'
$ResponsesDir = Join-Path $Root 'responses'
$ConfigPath = Join-Path $PSScriptRoot 'config.json'
$HeartbeatPath = Join-Path $PSScriptRoot 'heartbeat.json'
$LogPath = Join-Path $PSScriptRoot 'agent.log'

# BEGIN-CAPABILITIES (request type = the REMOTE_ALLOW entry it needs; empty = always allowed)
$CapabilityForType = @{
    'ping'       = ''
    'http'       = 'http'
    'db.query'   = 'db'
    'db.update'  = 'db'
    'exec'       = 'exec'
    'proc.start' = 'sap'
    'proc.send'  = 'sap'
    'proc.stop'  = 'sap'
    'shutdown'   = ''
}
# END-CAPABILITIES

Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName System.Net.Http
$Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Json.MaxJsonLength = [int]::MaxValue
$Json.RecursionLimit = 100
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Utf8Bom = New-Object System.Text.UTF8Encoding($true)

$script:Allow = @('http', 'db', 'sap')
$script:PollMs = 200
$script:HeartbeatMs = 2000
$script:ConfigStamp = $null
$script:Quit = $false
$script:Logoff = $false
$script:Procs = @{}
$script:TlsHelper = $false

# ---- small helpers ----------------------------------------------------------------------------------------

function Write-AgentLog([string]$Message) {
    try {
        $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' [' + $PID + '] ' + $Message
        if (Test-Path -LiteralPath $LogPath) {
            if ((Get-Item -LiteralPath $LogPath).Length -gt $MaxLogBytes) {
                $old = $LogPath + '.1'
                if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
                Move-Item -LiteralPath $LogPath -Destination $old -Force
            }
        }
        [System.IO.File]::AppendAllText($LogPath, $line + "`r`n", $Utf8NoBom)
    }
    catch { }
}

function Remove-Secrets([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $clean = [regex]::Replace($Text, '(?i)(password|pwd|passwd|secret|token|api[_-]?key)\s*=\s*("[^"]*"|''[^'']*''|[^;\s]*)', '$1=********')
    $clean = [regex]::Replace($clean, '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '$1********')
    return $clean
}

function Remove-Quietly([string]$Path) {
    try { if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force } }
    catch { }
}

function Throw-Remote([string]$Code, [string]$Message) {
    $ex = New-Object System.Exception($Message)
    $ex.Data['code'] = $Code
    throw $ex
}

function Get-ExceptionText($Ex) {
    $parts = New-Object System.Collections.ArrayList
    $current = $Ex
    while ($null -ne $current) {
        if (-not $parts.Contains($current.Message)) { [void]$parts.Add($current.Message) }
        $current = $current.InnerException
    }
    return ($parts -join ' -> ')
}

# Reads a key of a parsed JSON object (a Dictionary) or a hashtable; $Default when missing or null.
function Get-Prop($Obj, [string]$Name, $Default) {
    if ($Obj -is [System.Collections.IDictionary]) {
        foreach ($key in @($Obj.Keys)) {
            if ([string]$key -eq $Name) {
                $value = $Obj[$key]
                if ($null -ne $value) { return , $value }
            }
        }
    }
    return , $Default
}

# Writes <Path>.tmp, then renames it over <Path>, so a reader never sees half a file.
function Write-AtomicText([string]$Path, [string]$Text) {
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $Text, $Utf8NoBom)
    if (Test-Path -LiteralPath $Path) {
        try { [System.IO.File]::Replace($tmp, $Path, $null) }
        catch {
            [System.IO.File]::Copy($tmp, $Path, $true)
            [System.IO.File]::Delete($tmp)
        }
    }
    else {
        [System.IO.File]::Move($tmp, $Path)
    }
}

function Limit-Text([string]$Text) {
    if ($null -eq $Text) { return '' }
    if ($Text.Length -gt $MaxOutputChars) { return $Text.Substring(0, $MaxOutputChars) }
    return $Text
}

# Age of a mailbox file, measured against the heartbeat file's own write time: both are stamped by the test
# machine's clock, so a wrong clock on this host does not drop fresh requests or keep stale ones.
function Get-RequestAgeSeconds($File) {
    $now = [DateTime]::UtcNow
    try {
        if (Test-Path -LiteralPath $HeartbeatPath) { $now = (Get-Item -LiteralPath $HeartbeatPath).LastWriteTimeUtc }
    }
    catch { }
    return ($now - $File.LastWriteTimeUtc).TotalSeconds
}

# ---- config (agent\config.json is written by the client; re-read when it changes) ---------------------------

function Update-AgentConfig {
    try {
        if (-not (Test-Path -LiteralPath $ConfigPath)) { return }
        $stamp = (Get-Item -LiteralPath $ConfigPath).LastWriteTimeUtc
        if ($null -ne $script:ConfigStamp -and $script:ConfigStamp -eq $stamp) { return }
        $raw = $Json.DeserializeObject([System.IO.File]::ReadAllText($ConfigPath, $Utf8NoBom))
        $allow = Get-Prop $raw 'allow' $null
        if ($null -ne $allow) {
            $list = New-Object System.Collections.ArrayList
            foreach ($entry in $allow) { [void]$list.Add(([string]$entry).ToLowerInvariant()) }
            $script:Allow = $list.ToArray()
        }
        $poll = [int](Get-Prop $raw 'pollMs' 200)
        if ($poll -lt 20) { $poll = 20 }
        if ($poll -gt 5000) { $poll = 5000 }
        $script:PollMs = $poll
        $beat = [int](Get-Prop $raw 'heartbeatMs' 2000)
        if ($beat -lt 200) { $beat = 200 }
        if ($beat -gt 60000) { $beat = 60000 }
        $script:HeartbeatMs = $beat
        $script:ConfigStamp = $stamp
        Write-AgentLog ('config loaded: allow=' + ($script:Allow -join ',') + ' pollMs=' + $script:PollMs + ' heartbeatMs=' + $script:HeartbeatMs)
    }
    catch {
        Write-AgentLog ('config not loaded (keeping the previous one): ' + (Remove-Secrets (Get-ExceptionText $_.Exception)))
    }
}

function Test-Allowed([string]$Type) {
    $needed = [string]$CapabilityForType[$Type]
    if ($needed.Length -eq 0) { return $true }
    return ($script:Allow -contains $needed)
}

# ---- heartbeat (written from a second runspace, so a long request does not make the agent look dead) ----------

$HeartbeatCode = @'
function Write-HeartbeatFile($State) {
    $info = $State['info']
    $info['updatedAt'] = [DateTime]::UtcNow.ToString('o')
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $text = $serializer.Serialize($info)
    $path = [string]$State['path']
    $tmp = $path + '.tmp'
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $text, $encoding)
    if (Test-Path -LiteralPath $path) {
        try { [System.IO.File]::Replace($tmp, $path, $null) }
        catch {
            [System.IO.File]::Copy($tmp, $path, $true)
            [System.IO.File]::Delete($tmp)
        }
    }
    else {
        [System.IO.File]::Move($tmp, $path)
    }
    $State['lastBeat'] = [DateTime]::UtcNow
}
function Start-HeartbeatLoop($State) {
    while (-not $State['stop']) {
        try { Write-HeartbeatFile $State }
        catch { }
        Start-Sleep -Milliseconds ([int]$State['intervalMs'])
    }
}
'@
. ([scriptblock]::Create($HeartbeatCode))

# ---- process helpers --------------------------------------------------------------------------------------

# One argument of a Windows command line (CreateProcess rules: quotes and backslashes before quotes are escaped).
function ConvertTo-WinArg([string]$Arg) {
    if ($Arg.Length -gt 0 -and $Arg -notmatch '[\s"]') { return $Arg }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append([char]34)
    $backslashes = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq [char]92) {
            $backslashes++
        }
        elseif ($ch -eq [char]34) {
            [void]$sb.Append([char]92, ($backslashes * 2 + 1))
            [void]$sb.Append([char]34)
            $backslashes = 0
        }
        else {
            if ($backslashes -gt 0) { [void]$sb.Append([char]92, $backslashes); $backslashes = 0 }
            [void]$sb.Append($ch)
        }
    }
    if ($backslashes -gt 0) { [void]$sb.Append([char]92, ($backslashes * 2)) }
    [void]$sb.Append([char]34)
    return $sb.ToString()
}

# One argument for cmd.exe (best effort: wraps anything with spaces or cmd metacharacters in double quotes).
function ConvertTo-CmdArg([string]$Arg) {
    if ($Arg.Length -gt 0 -and $Arg -notmatch '[\s&|<>^()%!"]') { return $Arg }
    return ([string][char]34 + $Arg.Replace('"', '""') + [char]34)
}

# One argument as a PowerShell single-quoted literal.
function ConvertTo-PsLiteral([string]$Arg) {
    return ("'" + $Arg.Replace("'", "''") + "'")
}

function Stop-ProcessTree($Proc) {
    try { & taskkill.exe /PID $Proc.Id /T /F 2>&1 | Out-Null }
    catch { }
    try { if (-not $Proc.HasExited) { $Proc.Kill() } }
    catch { }
}

function Start-ChildProcess([string]$FileName, [string]$Arguments, [string]$WorkingDirectory, $EnvVars) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    if ($WorkingDirectory.Length -gt 0) { $psi.WorkingDirectory = $WorkingDirectory }
    if ($null -ne $EnvVars -and $EnvVars -is [System.Collections.IDictionary]) {
        foreach ($name in @($EnvVars.Keys)) { $psi.EnvironmentVariables[[string]$name] = [string]$EnvVars[$name] }
    }
    $proc = [System.Diagnostics.Process]::Start($psi)
    return , $proc
}

function ConvertTo-StringList($Value) {
    $list = New-Object System.Collections.ArrayList
    if ($null -ne $Value) {
        foreach ($item in $Value) { [void]$list.Add([string]$item) }
    }
    return , $list.ToArray()
}

# ---- handlers ---------------------------------------------------------------------------------------------

function Invoke-RemotePing($P) {
    return @{
        host         = [Environment]::MachineName
        user         = ([Environment]::UserDomainName + '\' + [Environment]::UserName)
        sessionId    = [int](Get-Process -Id $PID).SessionId
        interactive  = ([Environment]::UserInteractive -eq $true)
        psVersion    = $PSVersionTable.PSVersion.ToString()
        agentVersion = $AgentVersion
        pid          = [int]$PID
    }
}

function Invoke-RemoteHttp($P) {
    $url = [string](Get-Prop $P 'url' '')
    $method = ([string](Get-Prop $P 'method' 'GET')).ToUpperInvariant()
    if ($url.Length -eq 0) { Throw-Remote 'BAD_REQUEST' 'http needs a url' }
    $timeoutMs = [int](Get-Prop $P 'timeoutMs' 30000)
    $follow = ((Get-Prop $P 'followRedirects' $false) -eq $true)
    $ignoreTls = ((Get-Prop $P 'ignoreTlsErrors' $false) -eq $true)
    $useProxy = ((Get-Prop $P 'useProxy' $false) -eq $true)
    $bodyBase64 = [string](Get-Prop $P 'bodyBase64' '')
    $headers = Get-Prop $P 'headers' $null
    $started = [DateTime]::UtcNow

    if ($ignoreTls -and -not $script:TlsHelper) { Throw-Remote 'REMOTE_ERROR' 'ignoreTlsErrors is not available: the TLS helper could not be compiled on this host' }

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $follow
    $handler.UseProxy = $useProxy
    $handler.UseCookies = $false
    $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
    $client.Timeout = [TimeSpan]::FromMilliseconds($timeoutMs)
    $httpMethod = New-Object System.Net.Http.HttpMethod -ArgumentList $method
    $request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList $httpMethod, $url
    $previousCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        if ($bodyBase64.Length -gt 0) {
            $bytes = [Convert]::FromBase64String($bodyBase64)
            $request.Content = New-Object System.Net.Http.ByteArrayContent -ArgumentList (, $bytes)
        }
        if ($null -ne $headers -and $headers -is [System.Collections.IDictionary]) {
            foreach ($name in @($headers.Keys)) {
                $value = [string]$headers[$name]
                if (([string]$name) -like 'Content-*') {
                    if ($null -ne $request.Content) { [void]$request.Content.Headers.TryAddWithoutValidation([string]$name, $value) }
                }
                else {
                    [void]$request.Headers.TryAddWithoutValidation([string]$name, $value)
                }
            }
        }
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        if ($ignoreTls) { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = [RemoteAgentTls]::AcceptAll }
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
        }
        catch {
            $ex = $_.Exception
            $cancelled = ($ex -is [System.Threading.Tasks.TaskCanceledException])
            if ((-not $cancelled) -and ($null -ne $ex.InnerException)) { $cancelled = ($ex.InnerException -is [System.Threading.Tasks.TaskCanceledException]) }
            if ($cancelled) { Throw-Remote 'TIMEOUT' ('the http request did not finish within ' + $timeoutMs + ' ms') }
            throw
        }
        $statusCode = [int]$response.StatusCode
        $responseBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        $table = [ordered]@{}
        foreach ($h in $response.Headers) { $table[[string]$h.Key] = (@($h.Value) -join ', ') }
        foreach ($h in $response.Content.Headers) { $table[[string]$h.Key] = (@($h.Value) -join ', ') }
        $bodyOut = ''
        if ($null -ne $responseBytes -and $responseBytes.Length -gt 0) { $bodyOut = [Convert]::ToBase64String($responseBytes) }
        $finalUrl = $url
        if ($null -ne $response.RequestMessage -and $null -ne $response.RequestMessage.RequestUri) { $finalUrl = $response.RequestMessage.RequestUri.AbsoluteUri }
        return @{
            status     = $statusCode
            statusText = [string]$response.ReasonPhrase
            headers    = $table
            bodyBase64 = $bodyOut
            url        = $finalUrl
            durationMs = [long](([DateTime]::UtcNow - $started).TotalMilliseconds)
        }
    }
    finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCallback
        $request.Dispose()
        $client.Dispose()
    }
}

# Database values as JSON can carry them: NULL -> null, dates -> ISO 8601, binary -> base64, decimal and huge integers -> string.
function Convert-DbValue($Value) {
    if ($null -eq $Value -or $Value -is [System.DBNull]) { return $null }
    if ($Value -is [DateTime]) { return $Value.ToString('o') }
    if ($Value -is [DateTimeOffset]) { return $Value.ToString('o') }
    if ($Value -is [byte[]]) { return [Convert]::ToBase64String($Value) }
    if ($Value -is [decimal]) { return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [long]) {
        if ($Value -gt 9007199254740991 -or $Value -lt -9007199254740991) { return $Value.ToString() }
        return $Value
    }
    if ($Value -is [uint64]) {
        if ($Value -gt 9007199254740991) { return $Value.ToString() }
        return $Value
    }
    if ($Value -is [double] -or $Value -is [single]) {
        if ([double]::IsNaN([double]$Value) -or [double]::IsInfinity([double]$Value)) { return $Value.ToString() }
        return $Value
    }
    if ($Value -is [Guid] -or $Value -is [TimeSpan]) { return $Value.ToString() }
    return $Value
}

function Invoke-RemoteDb($P, [bool]$IsUpdate) {
    $provider = [string](Get-Prop $P 'provider' '')
    $connectionString = [string](Get-Prop $P 'connectionString' '')
    $sql = [string](Get-Prop $P 'sql' '')
    if ($provider.Length -eq 0 -or $connectionString.Length -eq 0 -or $sql.Length -eq 0) {
        Throw-Remote 'BAD_REQUEST' 'a db request needs provider, connectionString and sql'
    }
    $maxRows = [int](Get-Prop $P 'maxRows' $DefaultMaxRows)
    if ($maxRows -lt 1) { $maxRows = 1 }
    $timeoutMs = [int](Get-Prop $P 'timeoutMs' 30000)
    $paramValues = Get-Prop $P 'params' $null
    try { $factory = [System.Data.Common.DbProviderFactories]::GetFactory($provider) }
    catch { Throw-Remote 'BAD_REQUEST' ('DB provider "' + $provider + '" is not installed on this host: ' + (Get-ExceptionText $_.Exception)) }
    $conn = $factory.CreateConnection()
    $conn.ConnectionString = $connectionString
    $rows = New-Object System.Collections.ArrayList
    $count = 0
    $truncated = $false
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $cmd.CommandTimeout = [int][Math]::Max(1, [Math]::Ceiling($timeoutMs / 1000))
        $index = 0
        if ($null -ne $paramValues) {
            foreach ($value in $paramValues) {
                $parameter = $cmd.CreateParameter()
                $parameter.ParameterName = 'p' + $index
                if ($null -eq $value) { $parameter.Value = [System.DBNull]::Value }
                else { $parameter.Value = $value }
                [void]$cmd.Parameters.Add($parameter)
                $index++
            }
        }
        if ($IsUpdate) {
            $count = [int]$cmd.ExecuteNonQuery()
        }
        else {
            $reader = $cmd.ExecuteReader()
            try {
                $names = New-Object System.Collections.ArrayList
                for ($c = 0; $c -lt $reader.FieldCount; $c++) {
                    $name = [string]$reader.GetName($c)
                    if ($name.Length -eq 0) { $name = 'column' + $c }
                    $base = $name
                    $suffix = 1
                    while ($names.Contains($name)) { $name = $base + '_' + $suffix; $suffix++ }
                    [void]$names.Add($name)
                }
                while ($reader.Read()) {
                    if ($rows.Count -ge $maxRows) { $truncated = $true; break }
                    $row = [ordered]@{}
                    for ($c = 0; $c -lt $reader.FieldCount; $c++) { $row[[string]$names[$c]] = Convert-DbValue $reader.GetValue($c) }
                    [void]$rows.Add($row)
                }
            }
            finally { $reader.Dispose() }
            $count = $rows.Count
        }
    }
    finally {
        $conn.Dispose()
    }
    return @{ rows = $rows.ToArray(); rowCount = $count; truncated = $truncated }
}

function Invoke-RemoteExec($P) {
    $command = [string](Get-Prop $P 'command' '')
    if ($command.Length -eq 0) { Throw-Remote 'BAD_REQUEST' 'exec needs a command' }
    $argList = ConvertTo-StringList (Get-Prop $P 'args' $null)
    $shell = [string](Get-Prop $P 'shell' '')
    $cwd = [string](Get-Prop $P 'cwd' '')
    $timeoutMs = [int](Get-Prop $P 'timeoutMs' 60000)
    $envVars = Get-Prop $P 'env' $null

    if ($shell -eq 'powershell') {
        $line = $command
        foreach ($a in $argList) { $line = $line + ' ' + (ConvertTo-PsLiteral $a) }
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($line))
        $fileName = 'powershell.exe'
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
    }
    elseif ($shell -eq 'cmd') {
        $line = $command
        foreach ($a in $argList) { $line = $line + ' ' + (ConvertTo-CmdArg $a) }
        $fileName = 'cmd.exe'
        $arguments = '/d /s /c "' + $line + '"'
    }
    elseif ($shell.Length -eq 0) {
        $fileName = $command
        $parts = New-Object System.Collections.ArrayList
        foreach ($a in $argList) { [void]$parts.Add((ConvertTo-WinArg $a)) }
        $arguments = ($parts.ToArray() -join ' ')
    }
    else {
        Throw-Remote 'BAD_REQUEST' ('unknown shell "' + $shell + '" (use powershell or cmd)')
    }

    try { $proc = Start-ChildProcess $fileName $arguments $cwd $envVars }
    catch { Throw-Remote 'REMOTE_ERROR' ('could not start the command: ' + (Get-ExceptionText $_.Exception)) }
    $proc.StandardInput.Close()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $timedOut = $false
    if (-not $proc.WaitForExit($timeoutMs)) {
        $timedOut = $true
        Stop-ProcessTree $proc
    }
    [void]$outTask.Wait(5000)
    [void]$errTask.Wait(5000)
    $stdout = ''
    $stderr = ''
    if ($outTask.IsCompleted) { $stdout = Limit-Text $outTask.Result }
    if ($errTask.IsCompleted) { $stderr = Limit-Text $errTask.Result }
    $exitCode = -1
    if (-not $timedOut) { $exitCode = [int]$proc.ExitCode }
    $proc.Dispose()
    return @{ exitCode = $exitCode; stdout = $stdout; stderr = $stderr; timedOut = $timedOut }
}

# Stops a helper process (closes its stdin, waits a moment, then kills the tree) and forgets it.
function Stop-RemoteProc([string]$Id) {
    $state = $script:Procs[$Id]
    $script:Procs.Remove($Id)
    $exitCode = -1
    try { $state['stdin'].Close() } catch { }
    try {
        if (-not $state['proc'].WaitForExit(2000)) { Stop-ProcessTree $state['proc'] }
        $exitCode = [int]$state['proc'].ExitCode
    }
    catch { }
    if ($null -ne $state['tempFile']) { Remove-Quietly $state['tempFile'] }
    return $exitCode
}

function Invoke-RemoteProcStart($P) {
    $id = [string](Get-Prop $P 'id' '')
    if ($id -notmatch '^[A-Za-z0-9_-]{1,64}$') { Throw-Remote 'BAD_REQUEST' 'proc.start needs an id of letters, digits, - and _' }
    if ($script:Procs.ContainsKey($id)) { Throw-Remote 'BAD_REQUEST' ('a process with id ' + $id + ' already exists') }
    $scriptText = Get-Prop $P 'scriptText' $null
    $file = Get-Prop $P 'file' $null
    $shell = [string](Get-Prop $P 'shell' 'powershell')
    $argList = ConvertTo-StringList (Get-Prop $P 'args' $null)
    if (($null -eq $scriptText) -eq ($null -eq $file)) { Throw-Remote 'BAD_REQUEST' 'proc.start needs exactly one of scriptText or file' }
    $tempFile = $null
    if ($null -ne $scriptText) {
        if ($shell -ne 'powershell') { Throw-Remote 'BAD_REQUEST' 'scriptText is run with PowerShell; use file for shell cmd' }
        $tempFile = Join-Path $env:TEMP ('remote-agent-proc-' + $id + '-' + [Guid]::NewGuid().ToString('N') + '.ps1')
        [System.IO.File]::WriteAllText($tempFile, [string]$scriptText, $Utf8Bom)
        $target = $tempFile
    }
    else {
        $target = [string]$file
        if (-not (Test-Path -LiteralPath $target)) { Throw-Remote 'NOT_FOUND' ('script file not found on this host: ' + $target) }
    }
    $parts = New-Object System.Collections.ArrayList
    foreach ($a in $argList) { [void]$parts.Add((ConvertTo-WinArg $a)) }
    $argText = ''
    if ($parts.Count -gt 0) { $argText = ' ' + ($parts.ToArray() -join ' ') }
    if ($shell -eq 'cmd') {
        $fileName = 'cmd.exe'
        $arguments = '/d /s /c "' + (ConvertTo-WinArg $target) + $argText + '"'
    }
    elseif ($shell -eq 'powershell') {
        $fileName = 'powershell.exe'
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File ' + (ConvertTo-WinArg $target) + $argText
    }
    else {
        Throw-Remote 'BAD_REQUEST' ('unknown shell "' + $shell + '" (use powershell or cmd)')
    }
    try { $proc = Start-ChildProcess $fileName $arguments '' $null }
    catch {
        if ($null -ne $tempFile) { Remove-Quietly $tempFile }
        Throw-Remote 'REMOTE_ERROR' ('could not start the process: ' + (Get-ExceptionText $_.Exception))
    }
    $stdin = New-Object System.IO.StreamWriter -ArgumentList $proc.StandardInput.BaseStream, $Utf8NoBom
    $stdin.AutoFlush = $true
    $stdout = New-Object System.IO.StreamReader -ArgumentList $proc.StandardOutput.BaseStream, $Utf8NoBom
    $script:Procs[$id] = @{
        proc     = $proc
        stdin    = $stdin
        stdout   = $stdout
        stderr   = $proc.StandardError.ReadToEndAsync()
        tempFile = $tempFile
    }
    return @{ id = $id; pid = [int]$proc.Id }
}

function Invoke-RemoteProcSend($P) {
    $id = [string](Get-Prop $P 'id' '')
    $line = [string](Get-Prop $P 'line' '')
    $timeoutMs = [int](Get-Prop $P 'timeoutMs' 60000)
    if (-not $script:Procs.ContainsKey($id)) { Throw-Remote 'NOT_FOUND' ('no process with id ' + $id) }
    if ($line -match '[\r\n]') { Throw-Remote 'BAD_REQUEST' 'a line must not contain line breaks' }
    $state = $script:Procs[$id]
    if ($state['proc'].HasExited) {
        $code = Stop-RemoteProc $id
        Throw-Remote 'REMOTE_ERROR' ('the process has already exited (exit code ' + $code + ')')
    }
    try { $state['stdin'].WriteLine($line) }
    catch {
        [void](Stop-RemoteProc $id)
        Throw-Remote 'REMOTE_ERROR' 'could not write to the process (it has exited)'
    }
    $task = $state['stdout'].ReadLineAsync()
    if (-not $task.Wait($timeoutMs)) {
        [void](Stop-RemoteProc $id)
        Throw-Remote 'TIMEOUT' ('no answer line within ' + $timeoutMs + ' ms; the process was stopped, because a late answer would be taken for the next one')
    }
    $answer = $task.Result
    if ($null -eq $answer) {
        $code = Stop-RemoteProc $id
        Throw-Remote 'REMOTE_ERROR' ('the process ended without answering (exit code ' + $code + ')')
    }
    return @{ line = [string]$answer }
}

function Invoke-RemoteProcStop($P) {
    $id = [string](Get-Prop $P 'id' '')
    if (-not $script:Procs.ContainsKey($id)) { Throw-Remote 'NOT_FOUND' ('no process with id ' + $id) }
    $code = Stop-RemoteProc $id
    return @{ stopped = $true; exitCode = $code }
}

function Invoke-RemoteShutdown($P) {
    $script:Quit = $true
    $script:Logoff = ((Get-Prop $P 'logoff' $false) -eq $true)
    return @{ stopping = $true }
}

# ---- request processing -----------------------------------------------------------------------------------

function Send-Response($Id, $Response) {
    Write-AtomicText (Join-Path $ResponsesDir ($Id + '.json')) ($Json.Serialize($Response))
}

function Invoke-OneRequest($File) {
    $id = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
    if ($id -notmatch '^[A-Za-z0-9_-]{1,64}$') {
        Write-AgentLog 'ignoring a request file with an invalid name'
        Remove-Quietly $File.FullName
        return
    }
    if ((Get-RequestAgeSeconds $File) -gt $MaxRequestAgeSeconds) {
        Write-AgentLog ('dropping request ' + $id + ': older than ' + $MaxRequestAgeSeconds + ' seconds')
        Remove-Quietly $File.FullName
        return
    }
    $started = [DateTime]::UtcNow
    $type = ''
    $correlation = ''
    $response = $null
    try {
        $request = $Json.DeserializeObject([System.IO.File]::ReadAllText($File.FullName, $Utf8NoBom))
        if (-not ($request -is [System.Collections.IDictionary])) { Throw-Remote 'BAD_REQUEST' 'the request is not a JSON object' }
        $type = [string](Get-Prop $request 'type' '')
        $correlation = [string](Get-Prop $request 'correlationId' '')
        if ([int](Get-Prop $request 'v' 0) -ne $ProtocolVersion) { Throw-Remote 'BAD_REQUEST' ('unsupported protocol version (this agent speaks ' + $ProtocolVersion + ')') }
        if (-not $CapabilityForType.ContainsKey($type)) { Throw-Remote 'BAD_REQUEST' ('unknown request type "' + $type + '"') }
        if (-not (Test-Allowed $type)) { Throw-Remote 'DENIED' ('"' + $type + '" is not allowed by REMOTE_ALLOW (allowed: ' + ($script:Allow -join ', ') + ')') }
        $payload = Get-Prop $request 'payload' @{}
        $result = $null
        # BEGIN-DISPATCH
        switch ($type) {
            'ping'       { $result = Invoke-RemotePing $payload }
            'http'       { $result = Invoke-RemoteHttp $payload }
            'db.query'   { $result = Invoke-RemoteDb $payload $false }
            'db.update'  { $result = Invoke-RemoteDb $payload $true }
            'exec'       { $result = Invoke-RemoteExec $payload }
            'proc.start' { $result = Invoke-RemoteProcStart $payload }
            'proc.send'  { $result = Invoke-RemoteProcSend $payload }
            'proc.stop'  { $result = Invoke-RemoteProcStop $payload }
            'shutdown'   { $result = Invoke-RemoteShutdown $payload }
        }
        # END-DISPATCH
        $response = @{ v = $ProtocolVersion; id = $id; ok = $true; result = $result; durationMs = [long](([DateTime]::UtcNow - $started).TotalMilliseconds) }
        Write-AgentLog ('request ' + $id + ' ' + $type + ' ok (' + [long](([DateTime]::UtcNow - $started).TotalMilliseconds) + ' ms) ' + $correlation)
    }
    catch {
        $ex = $_.Exception
        $code = 'REMOTE_ERROR'
        if ($ex.Data.Contains('code')) {
            $code = [string]$ex.Data['code']
            $message = Remove-Secrets $ex.Message
        }
        else {
            $message = Remove-Secrets (Get-ExceptionText $ex)
        }
        $response = @{
            v          = $ProtocolVersion
            id         = $id
            ok         = $false
            error      = @{ code = $code; message = $message }
            durationMs = [long](([DateTime]::UtcNow - $started).TotalMilliseconds)
        }
        Write-AgentLog ('request ' + $id + ' ' + $type + ' failed: ' + $code + ' ' + $correlation)
    }
    try { Send-Response $id $response }
    catch { Write-AgentLog ('could not write the response for ' + $id + ': ' + (Remove-Secrets (Get-ExceptionText $_.Exception))) }
    Remove-Quietly $File.FullName
}

# Old leftovers: orphaned responses (nobody collected them), half-written .tmp files.
function Invoke-Housekeeping {
    foreach ($dir in @($RequestsDir, $ResponsesDir)) {
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
            if (($dir -eq $RequestsDir) -and $f.Name.EndsWith('.json')) { continue }
            if ((Get-RequestAgeSeconds $f) -gt $MaxRequestAgeSeconds) { Remove-Quietly $f.FullName }
        }
    }
}

# ---- start ------------------------------------------------------------------------------------------------

try {
    Add-Type -TypeDefinition @'
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class RemoteAgentTls {
    public static RemoteCertificateValidationCallback AcceptAll = new RemoteCertificateValidationCallback(Accept);
    private static bool Accept(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors) { return true; }
}
'@
    $script:TlsHelper = $true
}
catch {
    Write-AgentLog ('TLS helper not compiled (ignoreTlsErrors will be refused): ' + (Get-ExceptionText $_.Exception))
}

# One agent per session and mailbox: a second one would race the first for the same request files.
$MutexName = 'Local\RemoteAgentMailbox_' + ($Root -replace '[^A-Za-z0-9]', '_')
$Mutex = New-Object System.Threading.Mutex($false, $MutexName)
$MutexOwned = $false
try { $MutexOwned = $Mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $MutexOwned = $true }
if (-not $MutexOwned) {
    Write-AgentLog 'another agent already runs in this session for this mailbox; exiting'
    exit 0
}

Update-AgentConfig
$StartedAt = [DateTime]::UtcNow.ToString('o')
$Info = @{
    agentVersion = $AgentVersion
    pid          = [int]$PID
    host         = [Environment]::MachineName
    user         = ([Environment]::UserDomainName + '\' + [Environment]::UserName)
    sessionId    = [int](Get-Process -Id $PID).SessionId
    interactive  = ([Environment]::UserInteractive -eq $true)
    psVersion    = $PSVersionTable.PSVersion.ToString()
    startedAt    = $StartedAt
    updatedAt    = $StartedAt
    allow        = $script:Allow
}
$HbState = [hashtable]::Synchronized(@{ stop = $false; path = $HeartbeatPath; intervalMs = $script:HeartbeatMs; info = $Info; lastBeat = [DateTime]::MinValue })
Write-AgentLog ('agent ' + $AgentVersion + ' starting: root=' + $Root + ' session=' + $Info['sessionId'] + ' interactive=' + $Info['interactive'] + ' powershell=' + $Info['psVersion'])

$HbShell = $null
$HbRunspace = $null
try {
    try { Write-HeartbeatFile $HbState }
    catch { Write-AgentLog ('first heartbeat failed: ' + (Remove-Secrets (Get-ExceptionText $_.Exception))) }
    $HbRunspace = [runspacefactory]::CreateRunspace()
    $HbRunspace.Open()
    $HbShell = [powershell]::Create()
    $HbShell.Runspace = $HbRunspace
    [void]$HbShell.AddScript($HeartbeatCode + "`r`nStart-HeartbeatLoop `$args[0]").AddArgument($HbState)
    [void]$HbShell.BeginInvoke()

    $NextConfigCheck = [DateTime]::UtcNow.AddSeconds(1)
    $NextHousekeeping = [DateTime]::UtcNow.AddSeconds(10)
    $Unreachable = $false
    while (-not $script:Quit) {
        try {
            if ([DateTime]::UtcNow -ge $NextConfigCheck) {
                Update-AgentConfig
                $Info['allow'] = $script:Allow
                $NextConfigCheck = [DateTime]::UtcNow.AddSeconds(1)
            }
            if ([DateTime]::UtcNow -ge $NextHousekeeping) {
                Invoke-Housekeeping
                $NextHousekeeping = [DateTime]::UtcNow.AddSeconds(10)
            }
            # Fallback: if the heartbeat runspace died, beat from here (between requests).
            if (([DateTime]::UtcNow - $HbState['lastBeat']).TotalMilliseconds -gt ($script:HeartbeatMs * 3 + 1000)) { Write-HeartbeatFile $HbState }
            $files = @(Get-ChildItem -LiteralPath $RequestsDir -Filter '*.json' -File -ErrorAction Stop | Sort-Object LastWriteTimeUtc, Name)
            if ($Unreachable) { Write-AgentLog 'the mailbox is reachable again'; $Unreachable = $false }
            foreach ($file in $files) {
                if ($file.Name.EndsWith('.tmp')) { continue }
                Invoke-OneRequest $file
                if ($script:Quit) { break }
            }
        }
        catch {
            # The redirected drive is gone (the RDP window was closed or the session disconnected): keep waiting, it comes back on reconnect.
            if (-not $Unreachable) { Write-AgentLog ('the mailbox is not reachable: ' + (Remove-Secrets (Get-ExceptionText $_.Exception))); $Unreachable = $true }
            Start-Sleep -Milliseconds 2000
            continue
        }
        if (-not $script:Quit) { Start-Sleep -Milliseconds $script:PollMs }
    }
}
catch {
    Write-AgentLog ('agent crashed: ' + (Remove-Secrets (Get-ExceptionText $_.Exception)))
}
finally {
    foreach ($procId in @($script:Procs.Keys)) { [void](Stop-RemoteProc ([string]$procId)) }
    $HbState['stop'] = $true
    try { if ($null -ne $HbShell) { $HbShell.Stop(); $HbShell.Dispose() } } catch { }
    try { if ($null -ne $HbRunspace) { $HbRunspace.Close() } } catch { }
    Remove-Quietly $HeartbeatPath
    try { $Mutex.ReleaseMutex() } catch { }
    Write-AgentLog 'agent stopped'
}
if ($script:Logoff) {
    Write-AgentLog 'logging the session off (shutdown request with logoff)'
    & shutdown.exe /l
}
