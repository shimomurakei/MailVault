# addons.thunderbird.net listing

**Name:** MailVault
**Summary (max 250 characters):**
Keep mail only locally. Copies IMAP mail to matching local accounts with per-message confirmation, keeps stars and tags, sorts by sender, then moves the server copies to trash. Preview mode, server-vs-local index, masked log.

**Categories:** Message and News Reading; Tags; Miscellaneous
**Supported versions:** Thunderbird 115.0 and newer
**Default locale:** en (pl included)

**Description:**
MailVault moves your mailboxes off the server, safely and step by step.

For each IMAP account "X", it uses a local account named "X - lokalne" and runs a cycle with selectable steps:

1. Rebuild local folder indexes
2. Refresh server folders, so Thunderbird fetches the current message list
3. Copy server mail to local folders. Each copy is verified, and stars, tags and read state carry over.
4. Sort the local Inbox into per-sender folders
5. Remove local duplicates
6. Move server messages that have a verified local copy to server trash. On Gmail this includes All Mail.
7. Empty trash. Server trash loses only messages that have a local copy; local Trash is emptied completely.

Preview mode (on by default) changes nothing and reports what would happen. After every cycle, an index table shows server messages, local copies, missing copies, and starred, tagged and archived counts.

Cycles can run on demand, after start-up, or every N minutes.

Steps 6 and 7 permanently delete data. Test on a copy of your profile first.

No network access, no telemetry. The log masks e-mail addresses and never stores subjects.

**Notes for reviewers:**
No remote code, no external requests, no minified code. All logic is in background.js (cycle) and options.js (settings page, PL/EN).
