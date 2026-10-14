"use client";
import { useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Avatar, Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, TableWrap, Td, Th, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", general_manager: "General manager", restaurant_manager: "Restaurant manager", host: "Host / receptionist", service: "Service team", marketing_manager: "Marketing manager" };
const ROLE_DESC: Record<string, string> = {
  owner: "Everything, including billing and team.", general_manager: "Everything except billing.", restaurant_manager: "Run reservations, floor plan, guests, reports and booking settings for assigned locations.",
  host: "Take bookings, check guests in, seat and release tables, manage the waitlist.", service: "See reservations and the floor, mark tables ready.", marketing_manager: "Guests, campaigns, automations and analytics. No operational controls.",
};

export default function TeamPage() {
  const { t, fmt } = useI18n();
  const { can, me } = useApp();
  const { toast, confirm } = useFeedback();
  const { data, error, loading, reload } = useApi<any>("/api/v1/team"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dlg, setDlg] = useState(false); const [edit, setEdit] = useState<any>(null); const [matrix, setMatrix] = useState(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!can("team.manage")) return <NoAccess />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const assignable: string[] = data?.assignableRoles ?? [];
  async function remove(m: { id: string; name: string }) {
    if (!(await confirm({ title: t("Remove {name}?", { name: m.name }), message: t("They lose access immediately. Their past actions stay in the audit log."), tone: "danger", confirmLabel: t("Remove") }))) return;
    try { await api.del(`/api/v1/team/members/${m.id}`); toast.success(t("Member removed")); reload(); } catch (e) { toast.error(e); }
  }
  async function revoke(id: string) { try { await api.del(`/api/v1/team/invitations/${id}`); toast.success(t("Invitation revoked")); reload(); } catch (e) { toast.error(e); } }
  return (
    <>
      <PageHeader title={t("Team & permissions")} subtitle={t("Roles are enforced on the server for every action.")} actions={<><Button onClick={() => setMatrix(!matrix)} icon="shield">{t("Permission matrix")}</Button><Button variant="primary" icon="plus" onClick={() => setDlg(true)}>{t("Invite member")}</Button></>} />
      {loading && <Skeleton className="h-64" />}
      {data && (
        <div className="space-y-6">
          {matrix && <Matrix data={data} />}
          <TableWrap>
            <thead><tr><Th>{t("Member")}</Th><Th>{t("Role")}</Th><Th>{t("Locations")}</Th><Th>{t("Last login")}</Th><Th /></tr></thead>
            <tbody>{data.members.map((m: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
              <tr key={m.id} className={cx(m.status === "disabled" && "opacity-60")}>
                <Td><div className="flex items-center gap-3"><Avatar name={m.name} /><div><p className="font-medium">{m.name} {m.userId === me.user.id && <Badge>{t("you")}</Badge>}</p><p className="text-xs text-muted">{m.email}</p></div></div></Td>
                <Td><Badge tone={m.role === "owner" ? "gold" : "neutral"}>{t(ROLE_LABEL[m.role])}</Badge>{m.status === "disabled" && <Badge tone="bad" className="ms-1">{t("Disabled")}</Badge>}</Td>
                <Td className="text-sm">{m.locationIds ? m.locationIds.map((id: string) => me.locations.find((l) => l.id === id)?.name ?? "—").join(", ") : t("All locations")}</Td>
                <Td className="text-xs text-muted">{m.lastLoginAt ? fmt.date(m.lastLoginAt, { dateStyle: "medium", timeStyle: "short" }) : t("never")}</Td>
                <Td className="text-end whitespace-nowrap">{assignable.includes(m.role) && m.userId !== me.user.id && <><Button size="sm" variant="ghost" onClick={() => setEdit(m)}>{t("Edit")}</Button><Button size="sm" variant="ghost" className="!text-bad" onClick={() => remove(m)}>{t("Remove")}</Button></>}</Td>
              </tr>))}</tbody>
          </TableWrap>
          {data.invitations.length > 0 && (
            <Card><CardHeader title={t("Pending invitations")} />
              <ul className="divide-y divide-line">{data.invitations.map((i: any) => <li key={i.id} className="py-2.5 flex items-center gap-3 text-sm"><Icon name="mail" size={16} className="text-muted" /><span className="flex-1">{i.email}</span><Badge>{t(ROLE_LABEL[i.role])}</Badge><span className="text-xs text-muted">{t("expires {date}", { date: fmt.date(i.expiresAt, { day: "numeric", month: "short" }) })}</span><button className="text-bad text-sm hover:underline" onClick={() => revoke(i.id)}>{t("Revoke")}</button></li>)}</ul></Card>
          )}
        </div>
      )}
      <InviteDialog open={dlg} onClose={() => setDlg(false)} roles={assignable} onDone={reload} />
      <EditDialog member={edit} roles={assignable} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />
    </>
  );
}

function Matrix({ data }: { data: any }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t } = useI18n();
  const perms = [...new Set(Object.values(data.permissions).flat())] as string[];
  const roles = Object.keys(data.permissions);
  return (
    <Card pad={false}>
      <div className="p-5 pb-3"><CardHeader title={t("Who can do what")} /></div>
      <div className="overflow-x-auto scroll-thin"><table className="w-full text-xs"><thead><tr className="border-y border-line bg-canvas/70"><th className="text-start px-4 py-2 font-semibold">{t("Permission")}</th>{roles.map((r) => <th key={r} className="px-2 py-2 font-semibold text-center whitespace-nowrap">{t(ROLE_LABEL[r])}</th>)}</tr></thead>
        <tbody>{perms.sort().map((p) => <tr key={p} className="border-b border-line last:border-0"><td className="px-4 py-1.5 font-mono">{p}</td>{roles.map((r) => <td key={r} className="text-center">{data.permissions[r].includes(p) ? <Icon name="check" size={14} className="inline text-ok" /> : <span className="text-line-strong">–</span>}</td>)}</tr>)}</tbody></table></div>
    </Card>
  );
}

function LocationPicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { t } = useI18n(); const { me } = useApp();
  return (
    <div><p className="text-[13px] font-medium text-ink-2 mb-1.5">{t("Location access")}</p>
      <label className="flex items-center gap-2 text-sm mb-1.5"><input type="checkbox" className="accent-[var(--color-gold)]" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : [])} />{t("All locations (including future ones)")}</label>
      {value !== null && <div className="flex flex-wrap gap-2">{me.locations.map((l) => <label key={l.id} className={cx("rounded-lg border px-3 py-1.5 text-sm cursor-pointer", value.includes(l.id) ? "bg-charcoal text-white border-charcoal" : "border-line-strong")}><input type="checkbox" className="sr-only" checked={value.includes(l.id)} onChange={(e) => onChange(e.target.checked ? [...value, l.id] : value.filter((x) => x !== l.id))} />{l.name}</label>)}</div>}
    </div>
  );
}

function InviteDialog({ open, onClose, roles, onDone }: { open: boolean; onClose: () => void; roles: string[]; onDone: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const [email, setEmail] = useState(""); const [role, setRole] = useState("host"); const [locs, setLocs] = useState<string[] | null>(null); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false); const [link, setLink] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { const r = await api.post("/api/v1/team/invitations", { email, role, locationIds: locs }); toast.success(t("Invitation created")); setLink(r.devLink ?? null); onDone(); if (!r.devLink) close(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const close = () => { onClose(); setEmail(""); setLink(null); setLocs(null); setErr(null); };
  return (
    <Dialog open={open} onClose={close} title={t("Invite a team member")} footer={link ? <Button variant="primary" onClick={close}>{t("Done")}</Button> : <><Button onClick={close}>{t("Cancel")}</Button><Button variant="primary" loading={busy} disabled={!email} onClick={go}>{t("Send invitation")}</Button></>}>
      {link ? (
        <div className="space-y-3"><Notice tone="gold" title="Development mode">No email provider is connected, so the invitation email was not sent. Share this link manually:</Notice><Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" /><Button icon="copy" onClick={async () => { await navigator.clipboard?.writeText(link); toast.success(t("Link copied")); }}>{t("Copy link")}</Button></div>
      ) : (
        <div className="space-y-4 pt-1">
          <Field label={t("Email")} error={err?.fields.email}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
          <Field label={t("Role")} hint={t(ROLE_DESC[role])}><Select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}</Select></Field>
          <LocationPicker value={locs} onChange={setLocs} />
          {err && !err.fields.email && <Notice tone="bad">{err.message}</Notice>}
        </div>
      )}
    </Dialog>
  );
}

function EditDialog({ member, roles, onClose, onDone }: { member: any; roles: string[]; onClose: () => void; onDone: () => void }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t } = useI18n(); const { toast, confirm } = useFeedback();
  const [role, setRole] = useState(""); const [locs, setLocs] = useState<string[] | null>(null); const [status, setStatus] = useState("active"); const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  if (member && seen !== member.id) { setSeen(member.id); setRole(member.role); setLocs(member.locationIds); setStatus(member.status); }
  async function go() {
    if (role !== member.role && !(await confirm({ title: t("Change role?"), message: t("{name} will be signed out and get the permissions of the new role.", { name: member.name }), confirmLabel: t("Change role") }))) return;
    setBusy(true);
    try { await api.patch(`/api/v1/team/members/${member.id}`, { role, locationIds: locs, status }); toast.success(t("Member updated")); onDone(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!member} onClose={onClose} title={member ? member.name : ""} description={member?.email} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} onClick={go}>{t("Save")}</Button></>}>
      {member && <div className="space-y-4 pt-1"><Field label={t("Role")} hint={t(ROLE_DESC[role] ?? "")}><Select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}</Select></Field><LocationPicker value={locs} onChange={setLocs} />
        <Field label={t("Status")}><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">{t("Active")}</option><option value="disabled">{t("Disabled (cannot sign in)")}</option></Select></Field></div>}
    </Dialog>
  );
}
