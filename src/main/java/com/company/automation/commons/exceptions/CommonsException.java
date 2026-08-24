package com.company.automation.commons.exceptions;

/**
 * Unchecked exception thrown by every utility in this library. Wrapping
 * checked exceptions (IOException, SQLException, MessagingException, ...) in
 * this single unchecked type keeps every utility method's signature free of
 * {@code throws} clauses, so callers only need to handle failures they
 * actually care about instead of being forced to catch-or-declare on every
 * call site.
 */
public class CommonsException extends RuntimeException {

    public CommonsException(String message) {
        super(message);
    }

    public CommonsException(String message, Throwable cause) {
        super(message, cause);
    }
}
