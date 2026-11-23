# Team invitations

Ask: "Invite ana@example.com to our Sync team as an admin."

The API's `Invitations` operations become four generated tools, in the active
organization (`account_get-context` names it; `organizations_select` changes it):

- `invitations_list` (`GET /v2/invitations`, optional `status`) lists invitations in
  every status, without the code that accepts one. Any member can list them.
- `invitations_create` (`POST /v2/invitations`, `{ invitations: [{ email, role }] }`)
  emails each address a link that works for seven days, as `member` or `admin`. Up to
  100 addresses a call, 30 calls an hour.
- `invitations_resend` (`POST /v2/invitations/{id}/resend`) emails one again and gives
  it seven more days, including an expired one. 10 an hour.
- `invitations_delete` (`DELETE /v2/invitations/{id}`) cancels one, so its link stops
  working. It does not remove someone who already joined.

Inviting, resending and cancelling are for owners and admins. An API key needs the
`members:write` permission with admin access, which only an admin can turn on, and its
invitations come from the member who owns the key. Nothing is sent when any address is
already a member or already has an invitation in any status; the error names them, and
an earlier invitation is resent rather than created again. `team_seat_limit_reached`
means the plan has no seat for another member. On a plan that buys seats, accepting an
invitation when every seat is taken adds a paid seat. A partial send fails with the
addresses that were not emailed; their invitations exist and can be resent.

The tool descriptions tell the agent to confirm addresses, roles and the organization
before sending. The tools are listed on the hosted server to every client, ChatGPT and
Codex included, and locally in the `admin` toolset. After the deploy, rescan the
publisher so ChatGPT picks them up (see [the plugin notes](chatgpt-plugin.md#after-a-deploy-that-changes-tools));
until OpenAI reviews them they may show as not live there.
Argument telemetry records the shape of `invitations`, never the addresses.
