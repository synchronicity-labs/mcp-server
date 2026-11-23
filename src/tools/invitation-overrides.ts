import type { ToolOverride } from './asset-overrides.js';

const INVITATION_ID = 'Invitation id from invitations_list.';
const ADMINS_ONLY =
  'Organization owners and admins only; an API key needs the members:write permission with admin access, and acts as the member who owns it.';

// Team invitation tools, keyed by generated tool name; getOverride in overrides.ts reads
// these after its own entries.
export const INVITATION_OVERRIDES: Record<string, ToolOverride> = {
  invitations_list: {
    title: 'List team invitations',
    description:
      "List the invitations to join the current Sync organization (the one account_get-context names), in every status unless status narrows it. Each has id, email, role (member or admin), status (pending, accepted or expired), expiresAt and isResend. Use it to check whether someone was already invited, or to find the id that invitations_resend and invitations_delete take. It lists invitations, not the organization's members.",
    params: {
      status: 'Only invitations in this status: pending, accepted or expired. Omit for all.',
    },
  },
  invitations_create: {
    title: 'Invite people to the team',
    description: `Email each address an invitation to join the current Sync organization as a member or an admin; the link works for seven days. ${ADMINS_ONLY} It emails real people and cannot be unsent, so confirm the addresses, roles and organization with the user first. Up to 100 addresses a call, 30 calls an hour.\nNothing is sent when any address is already a member or already has an invitation in any status, including an expired one; the error names them. Drop the members, use invitations_resend for the invited ones, and call again with the rest.\nRefused with team_seat_limit_reached when the plan has no seat for another member. On a plan that buys seats, accepting an invitation when every seat is taken adds a paid seat to the subscription; say so before inviting to a full team.\nIf some emails fail to send, the error names those addresses; their invitations exist, so send them with invitations_resend rather than inviting again.`,
    params: {
      invitations:
        'The people to invite, each { email, role }, where role is member or admin. Use the addresses the user gave, exactly.',
    },
  },
  invitations_resend: {
    title: 'Resend a team invitation',
    description: `Email an invitation again and give it seven more days from now, including one that expired. ${ADMINS_ONLY} It emails the person again, so confirm with the user first. 10 resends an hour. Refused when the person is already a member, or with team_seat_limit_reached when the plan has no seat for another member.`,
    params: { id: INVITATION_ID },
  },
  invitations_delete: {
    title: 'Cancel a team invitation',
    description: `Cancel an invitation, so its link stops working. ${ADMINS_ONLY} It does not remove someone who has already joined. Confirm with the user first.`,
    params: { id: INVITATION_ID },
  },
};
