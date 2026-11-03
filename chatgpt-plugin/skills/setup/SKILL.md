---
name: setup
description: First-run setup for sync. labs after the plugin is installed. Confirms the connected account and its credits, shows what sync. labs can make, and walks the user to a first video. Use when the user runs setup for sync. labs or asks how to get started with it.
---

# Set up sync. labs

Gets a new user from install to a first result in about a minute. Setup itself never starts paid work.

## Tools

| Step | Tool |
| --- | --- |
| Account and credits | `get-account-context`, `get-account-usage` |

## Steps

1. **Account.** Call `get-account-context` and `get-account-usage`. Greet the user by their organization name and say what is available: credits, or the free allowance. Don't promote plans or pricing.
2. **Choices.** Offer the four things sync. labs makes, with one example prompt each:
   - **Make a photo talk:** "Make this photo say: welcome to my channel"
   - **Lipsync a video:** "Lipsync my video to this audio"
   - **Translate and dub:** "Dub this YouTube video into Spanish"
   - **Fix spoken words:** "Change the price I said in this video to $49"
3. **Fastest first win.** If the user isn't sure, suggest a talking photo, because it needs no upload. Create a character with image generation, write a one-line greeting together, and pick a voice. Then follow the talking-photo workflow: quote, get approval, create.
4. **Hand off.** Once the user picks, continue with the matching workflow (talking-photo, lipsync-video, translate-and-dub or edit-dialogue) in this conversation.

## Rules

- Quote before every paid video and wait for approval.
- If the account has no credits left, say so plainly and point to their sync. labs account; don't start a job that will fail.
- Keep it short: one message for the account and the choices, then follow the user's lead.
