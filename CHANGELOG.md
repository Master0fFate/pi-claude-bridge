# Changelog

## 0.1.1

Releases now ship as a download. Grab `pi-claude-bridge-v0.1.1.zip` (or the `.tar.gz`), unzip it, and run `pi install` on the folder. `SHA256SUMS.txt` lists the checksums.

Every change is now checked on Linux, macOS, and Windows with Node 22 and 24. The check runs a real Pi session against a stand-in `claude`: a reply, a tool call, a follow-up, an abort, a restart that resumes, cleanup when Pi is killed, and the error for a missing `claude`.

The bridge itself is unchanged from 0.1.0.

## 0.1.0

First release. Use your Claude Pro or Max subscription as a model provider in Pi.

The bridge runs the official Claude Code CLI as one long-lived process per Pi session and sends it only new messages and tool results. Pi restarts resume the same Claude session, and errors, retries, and aborts do not resend the conversation. A live run on Haiku sends 2 to 4 uncached input tokens per call after the first.
