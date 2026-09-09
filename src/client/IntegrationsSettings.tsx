import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Page } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";

type Capabilities = {
  readContent: boolean;
  insertContent: boolean;
  updateContent: boolean;
  readComments: boolean;
  insertComments: boolean;
  userInformation: "none" | "basic" | "email";
};

type Integration = {
  id: string;
  name: string;
  capabilities: Capabilities;
  token: { prefix: string; lastFour: string } | null;
  grantCount: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
};

type Webhook = {
  id: string;
  integrationId: string;
  integrationName?: string;
  url: string;
  events: string[];
  status: "pending_verification" | "active" | "paused";
};

type Delivery = {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: number;
};

const CAPABILITY_LABELS: Array<[keyof Omit<Capabilities, "userInformation">, string]> = [
  ["readContent", "Read content"],
  ["insertContent", "Insert content"],
  ["updateContent", "Update content"],
  ["readComments", "Read comments"],
  ["insertComments", "Insert comments"],
];

export function IntegrationsSettings({ owner, pages }: { owner: boolean; pages: Page[] }) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [grants, setGrants] = useState<Record<string, string[]>>({});
  const [revealedToken, setRevealedToken] = useState("");
  const [verification, setVerification] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!owner) return;
    try {
      const [integrationData, webhookData, deliveryData] = await Promise.all([
        api<{ integrations: Integration[] }>("/api/integrations"),
        api<{ subscriptions: Webhook[] }>("/api/webhooks"),
        api<{ deliveries: Delivery[] }>("/api/webhook-deliveries"),
      ]);
      setIntegrations(integrationData.integrations);
      setWebhooks(webhookData.subscriptions);
      setDeliveries(deliveryData.deliveries);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Integrations could not be loaded."));
    }
  }, [owner]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  if (!owner) return null;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ integration: Integration; token: string }>("/api/integrations", {
        method: "POST",
        body: json({ name: form.get("name") }),
      });
      setRevealedToken(result.token);
      event.currentTarget.reset();
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The integration could not be created."));
    }
  }

  async function patchIntegration(id: string, change: Partial<Capabilities>) {
    await api(`/api/integrations/${id}`, { method: "PATCH", body: json(change) });
    await load();
  }

  async function showGrants(integrationId: string) {
    const data = await api<{ grants: Array<{ id: string }> }>(`/api/integrations/${integrationId}/grants`);
    setGrants((current) => ({ ...current, [integrationId]: data.grants.map((grant) => grant.id) }));
  }

  async function toggleGrant(integrationId: string, pageId: string, checked: boolean) {
    const current = grants[integrationId] ?? [];
    const rootPageIds = checked ? [...new Set([...current, pageId])] : current.filter((id) => id !== pageId);
    await api(`/api/integrations/${integrationId}/grants`, { method: "PUT", body: json({ rootPageIds }) });
    setGrants((value) => ({ ...value, [integrationId]: rootPageIds }));
    await load();
  }

  async function rotate(integrationId: string) {
    if (!confirm("Rotate this token? The current token will stop working immediately.")) return;
    const result = await api<{ token: string }>(`/api/integrations/${integrationId}/rotate`, { method: "POST" });
    setRevealedToken(result.token);
    await load();
  }

  async function createWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/webhooks", {
      method: "POST",
      body: json({
        integrationId: form.get("integrationId"),
        url: form.get("url"),
        events: [
          "page.created",
          "page.content_updated",
          "page.properties_updated",
          "page.moved",
          "page.deleted",
          "page.undeleted",
          "comment.created",
          "comment.updated",
          "comment.deleted",
        ],
      }),
    });
    event.currentTarget.reset();
    await load();
  }

  return (
    <section className="integrations-settings">
      <div className="settings-heading">
        <div>
          <p className="eyebrow">Developer access</p>
          <h2>Integrations & webhooks</h2>
        </div>
        <button className="quiet-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="muted-copy">
        Tokens implement the Notion API subset at <code>/v1</code> and are shown only once.
      </p>
      <form className="integration-create" onSubmit={(event) => void create(event)}>
        <input name="name" required maxLength={100} placeholder="Integration name" />
        <button className="primary-small">Create integration</button>
      </form>
      {revealedToken && (
        <output className="secret-callout">
          <strong>Copy this token now</strong>
          <code>{revealedToken}</code>
          <button onClick={() => void navigator.clipboard.writeText(revealedToken)}>Copy</button>
          <button className="quiet-button" onClick={() => setRevealedToken("")}>
            I saved it
          </button>
        </output>
      )}
      <div className="integration-list">
        {integrations
          .filter((integration) => !integration.revokedAt)
          .map((integration) => (
            <article key={integration.id}>
              <header>
                <div>
                  <strong>{integration.name}</strong>
                  <small>
                    {integration.token
                      ? `${integration.token.prefix}••••${integration.token.lastFour}`
                      : "No active token"}{" "}
                    · {integration.grantCount} grants
                  </small>
                </div>
                <div>
                  <button onClick={() => void rotate(integration.id)}>Rotate token</button>
                  <button
                    className="text-danger"
                    onClick={async () => {
                      if (confirm(`Revoke ${integration.name}?`)) {
                        await api(`/api/integrations/${integration.id}`, { method: "DELETE" });
                        await load();
                      }
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </header>
              <div className="capability-grid">
                {CAPABILITY_LABELS.map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={integration.capabilities[key]}
                      onChange={(event) => void patchIntegration(integration.id, { [key]: event.target.checked })}
                    />{" "}
                    {label}
                  </label>
                ))}
                <label>
                  User information
                  <select
                    value={integration.capabilities.userInformation}
                    onChange={(event) =>
                      void patchIntegration(integration.id, {
                        userInformation: event.target.value as Capabilities["userInformation"],
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="basic">Basic</option>
                    <option value="email">Email</option>
                  </select>
                </label>
              </div>
              <details
                onToggle={(event) => {
                  if (event.currentTarget.open && grants[integration.id] === undefined) void showGrants(integration.id);
                }}
              >
                <summary>Page grants</summary>
                <div className="grant-list">
                  {pages
                    .filter((page) => page.archivedAt === null)
                    .map((page) => (
                      <label key={page.id}>
                        <input
                          type="checkbox"
                          checked={(grants[integration.id] ?? []).includes(page.id)}
                          onChange={(event) => void toggleGrant(integration.id, page.id, event.target.checked)}
                        />{" "}
                        {page.icon || "□"} {page.title}
                      </label>
                    ))}
                </div>
              </details>
              {integration.lastUsedAt && <small>Last used {new Date(integration.lastUsedAt).toLocaleString()}</small>}
            </article>
          ))}
      </div>
      <div className="webhook-settings">
        <h3>Webhook subscriptions</h3>
        <form onSubmit={(event) => void createWebhook(event)}>
          <select name="integrationId" required defaultValue="">
            <option value="" disabled>
              Choose integration
            </option>
            {integrations
              .filter((item) => !item.revokedAt)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
          <input name="url" type="url" required placeholder="https://example.com/webhooks/notion" />
          <button>Create webhook</button>
        </form>
        {webhooks.map((webhook) => (
          <article key={webhook.id} className="webhook-row">
            <div>
              <strong>{webhook.integrationName}</strong>
              <small>{webhook.url}</small>
              <span className={`status-pill status-${webhook.status}`}>{webhook.status.replaceAll("_", " ")}</span>
            </div>
            {webhook.status === "pending_verification" && (
              <div className="verify-row">
                <input
                  aria-label="Verification token"
                  placeholder="secret_…"
                  value={verification[webhook.id] ?? ""}
                  onChange={(event) => setVerification((current) => ({ ...current, [webhook.id]: event.target.value }))}
                />
                <button
                  onClick={async () => {
                    await api(`/api/webhooks/${webhook.id}/verify`, {
                      method: "POST",
                      body: json({ token: verification[webhook.id] }),
                    });
                    await load();
                  }}
                >
                  Verify
                </button>
                <button onClick={() => void api(`/api/webhooks/${webhook.id}/resend`, { method: "POST" })}>
                  Resend
                </button>
              </div>
            )}
            {webhook.status !== "pending_verification" && (
              <button
                onClick={async () => {
                  await api(`/api/webhooks/${webhook.id}`, {
                    method: "PATCH",
                    body: json({ paused: webhook.status === "active" }),
                  });
                  await load();
                }}
              >
                {webhook.status === "active" ? "Pause" : "Resume"}
              </button>
            )}
            <button
              className="text-danger"
              onClick={async () => {
                if (confirm("Delete this webhook?")) {
                  await api(`/api/webhooks/${webhook.id}`, { method: "DELETE" });
                  await load();
                }
              }}
            >
              Delete
            </button>
          </article>
        ))}
      </div>
      {deliveries.length > 0 && (
        <details className="delivery-history">
          <summary>Recent webhook deliveries</summary>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Response</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.eventType}</td>
                  <td>{delivery.status}</td>
                  <td>{delivery.attempts}</td>
                  <td>{delivery.responseStatus ?? delivery.lastError ?? "—"}</td>
                  <td>{new Date(delivery.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
