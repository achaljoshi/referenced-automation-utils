package com.company.automation.commons.email;

import com.company.automation.commons.exceptions.CommonsException;
import jakarta.mail.Folder;
import jakarta.mail.Message;
import jakarta.mail.MessagingException;
import jakarta.mail.PasswordAuthentication;
import jakarta.mail.Session;
import jakarta.mail.Store;
import jakarta.mail.Transport;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import jakarta.mail.search.SubjectTerm;

import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * SMTP send / IMAP read helpers built on Jakarta Mail (implementation:
 * Eclipse Angus). Used by tests that need to trigger an email (e.g. via a
 * test SMTP relay/mailbox such as Mailtrap/Mailhog) and then assert on its
 * contents, or send a test notification as part of a scenario.
 */
public final class EmailUtils {

    private EmailUtils() {
    }

    /** Sends a plain-text email over SMTP using the given host/port and, if non-blank, basic auth credentials. */
    public static void sendEmail(SmtpConfig config, String from, String to, String subject, String body) {
        Properties props = new Properties();
        props.put("mail.smtp.host", config.host());
        props.put("mail.smtp.port", String.valueOf(config.port()));
        props.put("mail.smtp.auth", String.valueOf(config.authRequired()));
        props.put("mail.smtp.starttls.enable", String.valueOf(config.startTls()));

        Session session = config.authRequired()
                ? Session.getInstance(props, new jakarta.mail.Authenticator() {
                    @Override
                    protected PasswordAuthentication getPasswordAuthentication() {
                        return new PasswordAuthentication(config.username(), config.password());
                    }
                })
                : Session.getInstance(props);

        try {
            MimeMessage message = new MimeMessage(session);
            message.setFrom(new InternetAddress(from));
            message.setRecipients(Message.RecipientType.TO, InternetAddress.parse(to));
            message.setSubject(subject);
            message.setText(body);
            Transport.send(message);
        } catch (MessagingException e) {
            throw new CommonsException("Failed to send email to " + to, e);
        }
    }

    /**
     * Searches an IMAP inbox for messages whose subject contains {@code subjectContains} and returns
     * their plain-text bodies, most recent first. Useful for asserting a verification/reset-password
     * email actually arrived during a test run.
     */
    public static List<String> searchInboxBySubject(ImapConfig config, String subjectContains, int maxResults) {
        Properties props = new Properties();
        props.put("mail.store.protocol", "imaps");

        Session session = Session.getInstance(props);
        List<String> bodies = new ArrayList<>();

        try (Store store = session.getStore("imaps")) {
            store.connect(config.host(), config.username(), config.password());
            Folder inbox = store.getFolder("INBOX");
            inbox.open(Folder.READ_ONLY);

            Message[] messages = inbox.search(new SubjectTerm(subjectContains));
            for (int i = messages.length - 1; i >= 0 && bodies.size() < maxResults; i--) {
                bodies.add(extractText(messages[i]));
            }
            inbox.close(false);
        } catch (MessagingException e) {
            throw new CommonsException("Failed to search inbox on " + config.host(), e);
        }
        return bodies;
    }

    private static String extractText(Message message) {
        try {
            Object content = message.getContent();
            return content instanceof String ? (String) content : String.valueOf(content);
        } catch (Exception e) {
            throw new CommonsException("Failed to read message content", e);
        }
    }

    public record SmtpConfig(String host, int port, boolean authRequired, boolean startTls,
                              String username, String password) {
        public static SmtpConfig noAuth(String host, int port) {
            return new SmtpConfig(host, port, false, false, null, null);
        }

        public static SmtpConfig withAuth(String host, int port, String username, String password) {
            return new SmtpConfig(host, port, true, true, username, password);
        }
    }

    public record ImapConfig(String host, String username, String password) {
    }
}
