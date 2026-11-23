import { describe, expect, it } from "vitest";
import { friendlyAuthError, validateEmail, validateNewPassword } from "../passwordAuth";

describe("passwordAuth", () => {
  it("validates email and new-password length", () => {
    expect(validateEmail(" a@b.co ")).toBeNull();
    expect(validateEmail("a@b")).not.toBeNull();
    expect(validateEmail("")).not.toBeNull();
    expect(validateNewPassword("1234567")).not.toBeNull();
    expect(validateNewPassword("12345678")).toBeNull();
  });

  it("never reveals whether an account exists on sign-in", () => {
    const wrongPassword = friendlyAuthError({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" }, "signin");
    const unknownUser = friendlyAuthError({ code: "user_not_found", status: 400, message: "User not found" }, "signin");
    const noCode = friendlyAuthError({ message: "Database error querying schema" }, "signin");
    expect(unknownUser).toBe(wrongPassword);
    expect(noCode).toBe(wrongPassword);
    expect(wrongPassword).not.toMatch(/not found|database|schema/i);
  });

  it("maps rate limits, unverified email and weak passwords", () => {
    expect(friendlyAuthError({ status: 429 }, "signin")).toMatch(/too many attempts/i);
    expect(friendlyAuthError({ code: "over_email_send_rate_limit" }, "reset")).toMatch(/too many attempts/i);
    expect(friendlyAuthError({ code: "email_not_confirmed" }, "signin")).toMatch(/verify your email/i);
    expect(friendlyAuthError({ code: "weak_password" }, "signup")).toMatch(/stronger password/i);
    expect(friendlyAuthError({ code: "user_already_exists" }, "signup")).toMatch(/sign in instead/i);
    expect(friendlyAuthError(null, "update")).toMatch(/expired/i);
  });
});
