import { useCallback, useEffect, useState, type FormEvent } from "react";
import QRCode from "react-qr-code";
import type { SecurityStatus } from "../shared/security";
import { ApiClientError, api, apiErrorMessage, authClient, json } from "./api";

async function securityAction<T = { success: boolean }>(path: string, body: object = {}): Promise<T> {
  return api<T>(`/api/security/${path}`, { method: "POST", body: json(body) });
}

export async function finishPasswordSignIn() {
  // An absent/expired trust cookie is expected and leaves the challenge intact.
  await securityAction("complete-trust").catch(() => undefined);
}

type Methods = {
  passkeys: Array<{ id: string; name: string | null }>;
  browsers: Array<{ id: string; name: string; expires_at: number }>;
};

export function SecurityScreen({
  initialStatus,
  onComplete,
  settings = false,
}: {
  initialStatus?: SecurityStatus;
  onComplete?: () => Promise<void>;
  settings?: boolean;
}) {
  const [status, setStatus] = useState<SecurityStatus | null>(initialStatus ?? null);
  const [methods, setMethods] = useState<Methods>({ passkeys: [], browsers: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [uri, setUri] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [resumeKey, setResumeKey] = useState("");
  const [resumeKeySaved, setResumeKeySaved] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [saved, setSaved] = useState(false);
  const [trust, setTrust] = useState(false);
  const [recover, setRecover] = useState(false);
  const [reset, setReset] = useState(false);
  const [hadSlackPrimary, setHadSlackPrimary] = useState(initialStatus?.slackPrimary?.available === true);

  const reload = useCallback(async () => {
    const next = await api<SecurityStatus>("/api/security/status");
    setStatus(next);
    if (next.slackPrimary?.available) setHadSlackPrimary(true);
    if (settings && next.state === "ready") setMethods(await api<Methods>("/api/security/methods"));
    return next;
  }, [settings]);
  useEffect(() => {
    let active = true;
    void (initialStatus ? Promise.resolve(initialStatus) : api<SecurityStatus>("/api/security/status"))
      .then(async (loaded) => {
        if (!active) return;
        setStatus(loaded);
        if (loaded.slackPrimary?.available) setHadSlackPrimary(true);
        if (settings && loaded.state === "ready") {
          const currentMethods = await api<Methods>("/api/security/methods");
          if (active) setMethods(currentMethods);
        }
      })
      .catch((cause) => {
        if (active) setError(apiErrorMessage(cause, "Unable to load security settings."));
      });
    return () => {
      active = false;
    };
  }, [settings, initialStatus]);
  useEffect(() => {
    const expiresAt = status?.slackPrimary?.expiresAt;
    if (!expiresAt || !status?.serverNow) return undefined;
    const timer = window.setTimeout(
      () => {
        setStatus((current) =>
          current?.slackPrimary?.expiresAt === expiresAt ? { ...current, slackPrimary: undefined } : current,
        );
        void reload().catch((cause) => setError(apiErrorMessage(cause, "Unable to refresh security settings.")));
      },
      Math.max(1000, expiresAt - status.serverNow + 1),
    );
    return () => window.clearTimeout(timer);
  }, [status?.slackPrimary?.expiresAt, status?.serverNow, reload]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (hadSlackPrimary && cause instanceof ApiClientError && cause.code === "SECURITY_REQUIRED") {
        await reload().catch(() => undefined);
      }
      setError(cause instanceof Error ? cause.message : "Security request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function verified(preserveCodes = true) {
    const next = await reload();
    setRecover(false);
    setSetup(false);
    setUri("");
    if (preserveCodes && codes.length > 0) {
      setNotice("Account protection verified. Continue to confirm your saved recovery codes.");
      return;
    }
    if (!next.codesSaved) {
      const generated = await securityAction<{ codes: string[]; receipt: string }>("recovery-codes");
      setCodes(generated.codes);
      setReceipt(generated.receipt);
      setSaved(false);
      return;
    }
    if (trust) await securityAction("trust");
    if (settings) setNotice("Account protection verified.");
    else await onComplete?.();
  }

  async function passkeySignIn() {
    const result = await authClient.signIn.passkey();
    if (result.error) throw new Error(result.error.message || "Passkey verification was cancelled or failed.");
    await verified();
  }

  async function addPasskey() {
    const result = await authClient.passkey.addPasskey({ name: "My passkey" });
    if (result.error)
      throw new Error(
        result.error.message || "Passkey setup was cancelled or is unavailable. Try an authenticator app.",
      );
    await verified();
  }

  function submit(event: FormEvent<HTMLFormElement>, action: (values: FormData) => Promise<void>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(() => action(values));
  }

  if (!status) return <output>Loading account protection…</output>;
  const enrollment = status.state === "enrollment_required" && !status.totp && !status.passkeys;
  const recoveryEnrollment = status.state === "recovery_required";
  const canManage =
    (recoveryEnrollment ? status.recoveryEnrollmentAllowed === true : status.fresh || enrollment) &&
    !status.recoveryKeyAcknowledgmentRequired;
  const slackPrimary = status.slackPrimary?.available === true;
  const primaryFactorFormVisible =
    codes.length === 0 &&
    resumeKey.length === 0 &&
    ((recoveryEnrollment && status.recoveryCanResume) ||
      ((enrollment || setup || recoveryEnrollment) && !uri) ||
      (!settings && !enrollment && recover));
  return (
    <section className={settings ? "security-settings" : "security-gate"} aria-label="Account protection">
      <h2>{settings ? "Security" : "Protect your account"}</h2>
      <p>Every account requires an authenticator app or a passkey. Passkeys use your device PIN or biometrics.</p>
      <div aria-live="polite">{notice && <p>{notice}</p>}</div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="security-controls">
        {!slackPrimary && hadSlackPrimary && primaryFactorFormVisible && (
          <div>
            <p>Your recent Slack sign-in expired. Enter your password below or sign in with Slack again.</p>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  const result = await authClient.signIn.social({
                    provider: "slack",
                    callbackURL: settings ? "/?view=settings" : "/",
                    errorCallbackURL: settings ? "/?view=settings&slackAuth=callback" : "/?slackAuth=callback",
                  });
                  if (result.error) throw new Error(result.error.message || "Slack sign-in failed.");
                })
              }
            >
              Sign in with Slack again
            </button>
          </div>
        )}
        {resumeKey ? (
          <>
            <h3>Save your recovery resume key</h3>
            <p>
              Store this key privately. It appears only now and is needed with your password or a fresh Slack sign-in if
              this recovery session is lost. It expires 24 hours after recovery started.
            </p>
            <pre className="recovery-codes">{resumeKey}</pre>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(resumeKey);
                  setNotice("Recovery resume key copied.");
                })
              }
            >
              Copy resume key
            </button>
            <label>
              <input
                type="checkbox"
                checked={resumeKeySaved}
                onChange={(event) => setResumeKeySaved(event.target.checked)}
              />{" "}
              I saved my recovery resume key
            </label>
            <button
              type="button"
              disabled={!resumeKeySaved}
              onClick={() =>
                void run(async () => {
                  try {
                    await securityAction("acknowledge-resume-key", { resumeKey });
                  } catch (cause) {
                    if (cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403)) {
                      setResumeKey("");
                      setResumeKeySaved(false);
                      if (cause.status === 403) await reload().catch(() => undefined);
                    }
                    throw cause;
                  }
                  setResumeKey("");
                  setResumeKeySaved(false);
                  await reload();
                  setNotice("Recovery resume key saved.");
                })
              }
            >
              Continue
            </button>
          </>
        ) : codes.length > 0 ? (
          <>
            <h3>Save your recovery codes</h3>
            <p>
              Each code works once after a fresh primary sign-in. These codes are shown only here; store them somewhere
              safe.
            </p>
            <pre className="recovery-codes">{codes.join("\n")}</pre>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(codes.join("\n"));
                  setNotice("Recovery codes copied.");
                })
              }
            >
              Copy recovery codes
            </button>
            <label>
              <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /> I saved my
              recovery codes
            </label>
            <button
              type="button"
              disabled={!saved}
              onClick={() =>
                void run(async () => {
                  await securityAction("acknowledge-codes", { receipt });
                  setCodes([]);
                  await verified(false);
                })
              }
            >
              Continue
            </button>
          </>
        ) : (
          <>
            {!status.codesSaved && status.fresh && (
              <button type="button" onClick={() => void run(verified)}>
                Generate recovery codes to finish setup
              </button>
            )}
            {recoveryEnrollment && status.recoveryCanResume && (
              <form
                className="auth-form"
                onSubmit={(event) =>
                  submit(event, async (values) => {
                    const result = await securityAction<{ success: boolean; resumeKey: string }>("resume-recovery", {
                      ...(slackPrimary ? {} : { password: values.get("password") }),
                      ...(status.recoveryResumeRequiresKey ? { resumeKey: values.get("resumeKey") } : {}),
                    });
                    setUri("");
                    setResumeKey(result.resumeKey);
                    setResumeKeySaved(false);
                    await reload();
                    setNotice("Recovery resumed. Save your new one-time resume key before continuing.");
                  })
                }
              >
                <p>If your ten-minute setup session expires, resume here within 24 hours of recovery.</p>
                {slackPrimary ? (
                  <p>Your recent Slack sign-in confirms the primary factor for this recovery step.</p>
                ) : (
                  <label>
                    Password to resume recovery
                    <input name="password" type="password" autoComplete="current-password" required />
                  </label>
                )}
                {status.recoveryResumeRequiresKey && (
                  <label>
                    Recovery resume key
                    <input name="resumeKey" autoComplete="off" required />
                  </label>
                )}
                <button>Resume recovery</button>
              </form>
            )}
            {status.recoveryKeyAcknowledgmentRequired && (
              <p>
                The key shown for this session was not saved. Resume recovery with fresh proof to issue another key.
              </p>
            )}
            {recoveryEnrollment && !status.recoveryEnrollmentAllowed && !status.recoveryKeyAcknowledgmentRequired && (
              <p>
                Resume recovery with fresh proof and save your recovery resume key before restoring account protection.
              </p>
            )}
            {(recoveryEnrollment ? status.recoveryEnrollmentAllowed : enrollment || setup) &&
              !status.recoveryKeyAcknowledgmentRequired && (
                <>
                  <h3>
                    {recoveryEnrollment ? "Restore account protection" : "Choose an authenticator app or passkey"}
                  </h3>
                  <button type="button" onClick={() => void run(addPasskey)}>
                    Create a passkey
                  </button>
                  {!uri ? (
                    <form
                      className="auth-form"
                      onSubmit={(event) =>
                        submit(event, async (values) => {
                          const result = await securityAction<{ totpURI: string }>(
                            "setup-totp",
                            slackPrimary ? {} : { password: values.get("password") },
                          );
                          setUri(result.totpURI);
                        })
                      }
                    >
                      {slackPrimary ? (
                        <p>Your recent Slack sign-in confirms the primary factor for authenticator setup.</p>
                      ) : (
                        <label>
                          Account password
                          <input name="password" type="password" autoComplete="current-password" required />
                        </label>
                      )}
                      <button>Set up authenticator app</button>
                    </form>
                  ) : (
                    <form
                      className="auth-form"
                      onSubmit={(event) =>
                        submit(event, async (values) => {
                          await securityAction("confirm-totp", { code: values.get("code") });
                          await verified();
                        })
                      }
                    >
                      <p>Scan this QR code in your authenticator app, or enter the setup key manually.</p>
                      <div className="security-qr">
                        <QRCode value={uri} size={192} />
                      </div>
                      <label>
                        Setup key
                        <input value={new URL(uri).searchParams.get("secret") ?? ""} readOnly />
                      </label>
                      <label>
                        Authenticator code
                        <input
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="[0-9]{6}"
                          maxLength={6}
                          required
                        />
                      </label>
                      <button>Verify authenticator</button>
                    </form>
                  )}
                  {settings && (
                    <button
                      type="button"
                      onClick={() => {
                        setSetup(false);
                        setUri("");
                      }}
                    >
                      Cancel setup
                    </button>
                  )}
                </>
              )}
            {!settings && (
              <label>
                <input type="checkbox" checked={trust} onChange={(event) => setTrust(event.target.checked)} /> Trust
                this browser for 30 days
              </label>
            )}
            {settings && (
              <>
                <p>Verify a factor again before changing security settings. At least one active method must remain.</p>
                <button type="button" disabled={!canManage} onClick={() => setSetup(true)}>
                  Add or replace an authenticator
                </button>
                <button type="button" disabled={!canManage} onClick={() => void run(addPasskey)}>
                  Add passkey
                </button>
                {status.totp && (
                  <button
                    type="button"
                    disabled={!status.fresh}
                    onClick={() =>
                      void run(async () => {
                        await securityAction("remove-factor", { kind: "totp" });
                        await reload();
                      })
                    }
                  >
                    Remove authenticator app
                  </button>
                )}
                {methods.passkeys.map((key) => (
                  <p key={key.id}>
                    {key.name || "Passkey"}{" "}
                    <button
                      type="button"
                      disabled={!status.fresh}
                      onClick={() =>
                        void run(async () => {
                          await securityAction("remove-factor", { kind: "passkey", id: key.id });
                          await reload();
                        })
                      }
                    >
                      Remove passkey
                    </button>
                  </p>
                ))}
                <button
                  type="button"
                  disabled={!status.fresh}
                  onClick={() =>
                    void run(async () => {
                      const result = await securityAction<{ codes: string[]; receipt: string }>("recovery-codes");
                      setCodes(result.codes);
                      setReceipt(result.receipt);
                      setSaved(false);
                    })
                  }
                >
                  Replace recovery codes
                </button>
                <h3>Trusted browsers</h3>
                {methods.browsers.length === 0 && <p>No trusted browsers.</p>}
                {methods.browsers.map((browser) => (
                  <p key={browser.id}>
                    {browser.name} — expires {new Date(browser.expires_at).toLocaleDateString()}{" "}
                    <button
                      type="button"
                      disabled={!status.fresh}
                      onClick={() =>
                        void run(async () => {
                          await securityAction("revoke-trust", { id: browser.id });
                          await reload();
                        })
                      }
                    >
                      Revoke browser
                    </button>
                  </p>
                ))}
              </>
            )}
            {!settings && !enrollment && (
              <>
                <button type="button" onClick={() => setRecover(!recover)}>
                  Use a recovery code or operator reset
                </button>
                {recover && (
                  <form
                    className="auth-form"
                    onSubmit={(event) =>
                      submit(event, async (values) => {
                        const result = await securityAction<{ success: boolean; resumeKey: string }>("recover", {
                          ...(slackPrimary ? {} : { password: values.get("password") }),
                          code: values.get("code"),
                          reset,
                        });
                        setResumeKey(result.resumeKey);
                        setResumeKeySaved(false);
                        setRecover(false);
                        await reload();
                      })
                    }
                  >
                    {slackPrimary ? (
                      <p>Your recent Slack sign-in confirms the primary factor for recovery.</p>
                    ) : (
                      <label>
                        Account password
                        <input name="password" type="password" autoComplete="current-password" required />
                      </label>
                    )}
                    <label>
                      {reset ? "Operator reset token" : "Recovery code"}
                      <input name="code" autoComplete="off" required />
                    </label>
                    <label>
                      <input type="checkbox" checked={reset} onChange={(event) => setReset(event.target.checked)} /> I
                      have an operator reset token
                    </label>
                    <p>
                      Recovery signs out other sessions and revokes trusted browsers. You must restore account
                      protection before entering the workspace.
                    </p>
                    <button>Recover account</button>
                  </form>
                )}
              </>
            )}
          </>
        )}
        {!enrollment && !setup && (
          <>
            {status.passkeys > 0 && (
              <button type="button" onClick={() => void run(passkeySignIn)}>
                Verify with passkey
              </button>
            )}
            {status.totp && (
              <form
                className="auth-form"
                onSubmit={(event) =>
                  submit(event, async (values) => {
                    const result = await authClient.twoFactor.verifyTotp({
                      code: String(values.get("code")),
                      trustDevice: false,
                    });
                    if (result.error) throw new Error(result.error.message || "The code is invalid.");
                    await verified();
                  })
                }
              >
                <label>
                  Authenticator code
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                  />
                </label>
                <button>Verify code</button>
              </form>
            )}
          </>
        )}
      </fieldset>
      {!settings && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await authClient.signOut();
              if (result.error) throw new Error(result.error.message || "Sign out failed.");
              await onComplete?.();
            })
          }
        >
          Sign out
        </button>
      )}
    </section>
  );
}
