// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext, Page } from "../shared/types";
import { api, ApiClientError } from "./api";
import { TableAuthorityGate } from "./TableAuthorityGate";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
vi.mock("./CollaborativeTablePage", () => ({ CollaborativeTablePage: () => <div>Authoritative table reader</div> }));
const page = { id: "table", kind: "table" } as Page;
const member = { role: "owner", user: { id: "owner" } } as ClientMemberContext;
function show(context = member) {
  render(<TableAuthorityGate page={page} member={context} legacy={<div>Legacy table</div>} onSelectPage={vi.fn()} />);
}
beforeEach(() => vi.mocked(api).mockReset());
describe("table authority rollout", () => {
  it("probes authority with cutover disabled and keeps unmigrated tables on the legacy reader", async () => {
    vi.mocked(api).mockResolvedValue({ authority: null });
    show();
    expect(await screen.findByText("Legacy table")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table/authority");
    expect(screen.queryByRole("button", { name: /Enable collaborative/ })).toBeNull();
  });
  it("reads migrated tables when the cutover flag is disabled", async () => {
    vi.mocked(api).mockResolvedValue({ authority: { state: "do" } });
    show();
    expect(await screen.findByText("Authoritative table reader")).toBeInTheDocument();
    expect(screen.queryByText("Legacy table")).toBeNull();
  });
  it("requires both owner role and the feature to offer cutover", async () => {
    vi.mocked(api).mockResolvedValue({ authority: null });
    show({ ...member, role: "editor", features: { expandedEmbeds: false, tableAuthority: true } });
    await screen.findByText("Legacy table");
    expect(screen.queryByRole("button", { name: /Enable collaborative/ })).toBeNull();
  });
  it("fences the legacy reader while a failed seed is resumed", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ authority: { state: "seeding" } })
      .mockRejectedValueOnce(new ApiClientError(409, "table_seed_mismatch", "The seed differs. Retry migration."));
    show({ ...member, features: { expandedEmbeds: false, tableAuthority: true } });
    fireEvent.click(await screen.findByRole("button", { name: "Resume table migration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The seed differs");
    expect(screen.queryByText("Legacy table")).toBeNull();
    expect(api).toHaveBeenCalledWith("/api/tables/table/authority", expect.objectContaining({ method: "POST" }));
  });
  it("switches to authority only after successful verified cutover", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ authority: null })
      .mockResolvedValueOnce({ authority: { state: "do" } });
    show({ ...member, features: { expandedEmbeds: false, tableAuthority: true } });
    fireEvent.click(await screen.findByRole("button", { name: /Enable collaborative/ }));
    await waitFor(() => expect(screen.getByText("Authoritative table reader")).toBeInTheDocument());
    expect(screen.queryByText("Legacy table")).toBeNull();
  });
});
