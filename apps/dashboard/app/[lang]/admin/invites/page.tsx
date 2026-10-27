import type { Metadata } from "next";
import { InvitesTable } from "@/components/admin/invites-table";

export const metadata: Metadata = {
  title: "Invites | Admin Dashboard",
  description: "Invite people to CloudBot",
};

export default function InvitesPage() {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <InvitesTable />
    </div>
  );
}
