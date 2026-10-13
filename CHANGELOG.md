# Changelog

## 0.1.3

The models now use Anthropic's published limits: a 1M-token context window and 128K output for Opus 5.5, Sonnet 5.5, Haiku 5.5, and Fable 5.1. Before, the bridge declared 200K, so Pi compacted long sessions far too early.

You can change the context window and output limit per model with `modelOverrides` in Pi's `models.json` (`~/.pi/agent/models.json` for Pi, `~/.pi/fateGUI/models.json` for Fate UI). The README shows the format.

## 0.1.2

Loading a conversation into a new Claude session now has a stop condition. Before, a fresh start, a reset, or a provider switch could push a history of any size into Claude, which then either failed or made Claude Code run its own expensive compaction. Now the bridge estimates the size first. If it does not fit the model's context window minus 16k tokens, the call fails with "Prompt is too long" before Claude starts, Pi compacts the conversation, and the retry goes through with the summary.

Claude Code's own auto-compaction is now off inside the bridge, so Pi is the only thing that compacts and no hidden second summary is billed to your plan.

## 0.1.1

Releases now ship as a download. Grab `pi-claude-bridge-v0.1.1.zip` (or the `.tar.gz`), unzip it, and run `pi install` on the folder. `SHA256SUMS.txt` lists the checksums.

Every change is now checked on Linux, macOS, and Windows with Node 22 and 24. The check runs a real Pi session against a stand-in `claude`: a reply, a tool call, a follow-up, an abort, a restart that resumes, cleanup when Pi is killed, and the error for a missing `claude`.

The bridge itself is unchanged from 0.1.0.

## 0.1.0

First release. Use your Claude Pro or Max subscription as a model provider in Pi.

The bridge runs the official Claude Code CLI as one long-lived process per Pi session and sends it only new messages and tool results. Pi restarts resume the same Claude session, and errors, retries, and aborts do not resend the conversation. A live run on Haiku sends 2 to 4 uncached input tokens per call after the first.
