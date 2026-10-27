"use client";

import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardTranslations } from "@/contexts/dashboard-translations";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { adminApiFetcher } from "@workspace/ui/lib/fetcher";
import { format } from "date-fns";
import { MailPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

const statusBadgeClasses = {
  pending:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900 dark:text-blue-200",
  accepted:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900 dark:text-green-200",
  expired:
    "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-700 dark:bg-yellow-900 dark:text-yellow-200",
};

export function InvitesTable() {
  const { locale, sharedT } = useSharedTranslations();
  const { dashboardT } = useDashboardTranslations();
  const t = dashboardT.invitesTable;
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string;
    email: string;
  } | null>(null);

  const { data: invites, error } = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () =>
      adminApiFetcher((client) => client.invites.$get(), sharedT.apiCodes),
    staleTime: 0,
  });

  const refreshInvites = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-invites"] });

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setIsSending(true);
      await adminApiFetcher(
        (client) => client.invites.$post({ json: { email, locale } }),
        sharedT.apiCodes,
      );
      toast.success(t.sent.replace("{email}", email));
      setEmail("");
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      }
    } finally {
      setIsSending(false);
      refreshInvites();
    }
  };

  const handleRevoke = async (invite: { id: string; email: string }) => {
    try {
      await adminApiFetcher(
        (client) =>
          client.invites[":inviteId"].$delete({
            param: { inviteId: invite.id },
          }),
        sharedT.apiCodes,
      );
      toast.success(t.revoked.replace("{email}", invite.email));
      refreshInvites();
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      }
    }
  };

  const columns = [
    t.email,
    t.status,
    t.invitedAt,
    t.expiresAt,
    t.actions,
  ];

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleInvite}
        className="mb-2 flex w-full flex-wrap items-end gap-2"
      >
        <Input
          type="email"
          required
          placeholder={t.emailPlaceholder}
          className="w-72"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" disabled={isSending}>
          <MailPlus className="h-4 w-4" />
          {isSending ? t.sending : t.sendInvite}
        </Button>
      </form>

      {error ? (
        <div>{t.failedToLoad}</div>
      ) : (
        <div className="border-muted overflow-hidden rounded-lg border-2">
          <Table className="text-sm">
            <TableHeader className="bg-muted sticky top-0 z-10">
              <TableRow>
                {columns.map((label) => (
                  <TableHead
                    key={label}
                    className="text-muted-foreground px-4 py-3 text-xs font-medium"
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!invites ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <TableRow key={index}>
                    {columns.map((label) => (
                      <TableCell key={label} className="px-4 py-3">
                        <Skeleton className="h-4 w-30" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : invites.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="text-muted-foreground px-4 py-6 text-center"
                  >
                    {t.noInvites}
                  </TableCell>
                </TableRow>
              ) : (
                invites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell className="text-foreground px-4 py-3 font-medium">
                      {invite.email}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={`px-2 py-1 text-xs ${statusBadgeClasses[invite.status]}`}
                      >
                        {t.statuses[invite.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground px-4 py-3 text-xs">
                      {format(new Date(invite.createdAt), "MMM d, yyyy 'at' h:mm a")}
                    </TableCell>
                    <TableCell className="text-muted-foreground px-4 py-3 text-xs">
                      {invite.status === "accepted"
                        ? "—"
                        : format(
                            new Date(invite.expiresAt),
                            "MMM d, yyyy 'at' h:mm a",
                          )}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      {invite.status !== "accepted" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRevokeTarget(invite)}
                        >
                          {t.revoke}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {revokeTarget && (
        <ConfirmationDialog
          isOpen
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => handleRevoke(revokeTarget)}
          title={t.revokeTitle.replace("{email}", revokeTarget.email)}
          description={t.revokeDescription}
          confirmText={t.revoke}
          confirmVariant="destructive"
        />
      )}
    </div>
  );
}
