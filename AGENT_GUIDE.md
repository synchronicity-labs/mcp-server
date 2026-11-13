# sync. labs: guide for the agent that set it up

You just connected this person to sync. labs (sync.so): AI lipsync and dubbing for video.
`setup` prints this guide when it finishes, and `npx -y @sync.so/mcp-server@latest guide`
prints it again. It is for coding agents, and it is not part of the sync. skills.

## Tell the person now

Say this once, briefly and in your own words, then wait for them.

1. **Start a new session.** The sync. tools and skills load when a session starts.
2. **What they can ask for then.** Give two or three of these as examples:
   - Lipsync a video: "Lipsync ./interview.mp4 to ./new-take.wav"
   - Make a photo talk: "Make this portrait say: welcome to the team"
   - Translate and dub: "Dub this YouTube video into Spanish"
   - Fix a few spoken words: "Change the price I say in this video to $49"
   - Many videos at once: "Lipsync each row of this CSV"
3. **What they have.** A new account is on the Free plan, with a few short generations
   each month. The tools report the exact allowance in the new session.
4. **They can pay from here.** They never need the website to see plans or prices: when
   they ask, you list the plans and what each costs, and they pick. You then pay from
   their wallet if they have one, or give them one link to approve.

## In later sessions

**What they can make.** The sync. skills were installed with this setup. Follow the skill
that matches the request (`lipsync`, `talking-photo`, `translate-and-dub`, `edit-dialogue`,
`localize-campaign`, `batch-lipsync`, `troubleshoot`, `sync-api`). When the person does not
know where to start, run the `setup` skill: it reads their account and offers a first
result.

**Plans and paying.** The skills leave this to you.

- `billing-plans_list` lists what this organization can buy and the price of each. Call it
  when the person asks about plans, prices or upgrading, and before you suggest a plan
  after a refusal.
- Say the price, and that a plan renews every month, and get a yes before anything is paid.
- With a wallet that pays Machine Payments Protocol URLs, such as Link CLI:
  `billing-payment-links_create`, then have the wallet pay the `url` it returns.
- Without one: `billing-approval-links_create`, then give the person the `url`. They pay on
  that page and nothing else is needed from the website.
- Afterwards `account_get-context` shows the plan and `account_get-usage` the credits.
  Check them before you retry a refused request.
- Mention plans once, here. After that bring them up only when the person asks or when
  sync. refuses a request for a plan or credits. Never start paid work without a quote.
