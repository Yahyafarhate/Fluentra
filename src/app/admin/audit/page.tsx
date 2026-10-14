"use client";
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { useI18n } from "@/lib/i18n/client";
import { useApi } from "@/lib/client/hooks";

export default function AdminAudit() {
  const { fmt } = useI18n();
  const { data, error, reload } = useApi<{ entries: any[] }>("/api/admin/audit");  
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title="Platform audit log" subtitle="All tenants and platform actions, newest first" />
      {data.entries.length === 0 ? <EmptyState icon="shield" title="No entries" /> : <TableWrap><thead><tr><Th>When</Th><Th>Organization</Th><Th>Actor</Th><Th>Action</Th><Th>Details</Th></tr></thead><tbody>{data.entries.map((e) => <tr key={e.id}><Td className="text-xs whitespace-nowrap tabular">{fmt.date(e.createdAt, { dateStyle: "medium", timeStyle: "short" })}</Td><Td className="text-xs">{e.orgName ?? "—"}</Td><Td className="text-xs">{e.actorLabel}</Td><Td><Badge>{e.action}</Badge></Td><Td className="text-xs text-muted max-w-sm truncate">{Object.keys(e.metadata ?? {}).length ? JSON.stringify(e.metadata) : ""}</Td></tr>)}</tbody></TableWrap>}
    </>
  );
}
