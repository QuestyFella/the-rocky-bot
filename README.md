# Task Board Discord Bot

A Discord bot for a simple shared task board. Members find a task, claim it, and mark it done.

## How it works

A manager runs `!task setup` once. The bot posts a live board that updates by itself. It shows a card for **In Progress** work, then one coloured card per `[TAG]` category (the tag at the start of each title). Each task shows its key, title, the first paragraph of its description, and its due date. Done tasks are counted but not listed. Keep the first paragraph of a description short and plain; put technical details after a blank line, and they show only when someone opens the task.

Members need three buttons:

1. **Find Work**: pick an open task (use the category menu at the top to show only one category), then click **Claim**. The task becomes yours and moves to In Progress.
2. **My Tasks**: pick your task, then click **Mark Done**, or **Unclaim** to hand it back.
3. **Add Task**: a short form with a title, an optional description, and an optional due date. Start the title with a tag like `[POWER]` to group it.

**Locked tasks.** A task can be blocked by other tasks in the same `[TAG]` category. It stays hidden from the board and Find Work, and can't be claimed, until those tasks are done. The board shows how many tasks are still locked in each category. Tasks in other categories never block it. Managers set blockers with `!task block KEY OTHER-1, OTHER-2` (or `none`).

**Exec board.** A manager runs `!task setup exec` in a private exec channel. Tasks added or imported there go on the exec board only. Each channel only sees, and can only change, its own board's tasks.

The person working on a task, its creator, and server managers (Manage Server or Administrator) can mark it done, unclaim, reopen, edit, or delete it. Deleting asks for confirmation. Task views are private to the person who clicked.

## Commands

- `!task` - Show the board
- `!task add [TAG] Title` - Add a task
- `!task claim KEY` - Take a task (moves it to In Progress)
- `!task done KEY` / `!task unclaim KEY` / `!task reopen KEY`
- `!task details KEY` - Show one task
- `!task edit KEY New title` / `!task due KEY 2026-12-01|none` / `!task delete KEY`
- `!task help` - Show help

Managers:

- `!task setup` - Post the live board in the current channel
- `!task setup exec` - Post the exec board in the current channel
- `!task block KEY OTHER-1, OTHER-2|none` - Hide a task until the listed same-category tasks are done
- `!task refresh` - Redraw the live board
- `!task assign KEY @user|none` - Assign a task to someone
- `!task import` - Attach a `.txt`/`.md` list or paste it after the command, then confirm the preview. Each task starts with `Title:`, optionally followed by `Description:` (can span lines) and `Due date: YYYY-MM-DD`. Numbering, headings, and the old `Priority:`/`Team:` lines are ignored. Titles already on the board are skipped. Up to 250 tasks per import.
- `!task setchannel [add|remove|list] [#channel]` - Limit the channels where the bot responds
- `!task role all @Role [remove]` - Add or remove a role for everyone (Manage Roles)

Aliases: `start` = claim, `close` = done, `release` = unclaim, `view` = details, `rename` = edit, `remove` = delete, and `board`/`list`/`kanban`/`jira` = show.

## Reorganizing existing tasks

`scripts/apply-board-plan.js` applies a JSON plan that sets each task's title (and so its category), board, and blockers. It previews by default and checks that blockers are in the same category and form no loops. With `--apply` it saves a backup next to the task file. Stop the bot first, because it caches tasks in memory:

```sh
pm2 stop the-bot
BOT_DATA_DIR=~/the-rocky-bot node scripts/apply-board-plan.js --guild ID --plan plan.json --apply
pm2 start the-bot
```

Plan rows look like `{ "key": "URC-15", "title": "[FIRMWARE] Watchdog", "board": "main", "blockedBy": ["URC-14"] }`. Plan files and backups stay on the server, outside the repository.

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Create a Discord bot application at the [Discord Developer Portal](https://discord.com/developers/applications)
4. Copy your bot token
5. Create a `.env` file in the root directory with the following content:
   ```
   DISCORD_TOKEN=your_bot_token_here
   ```
6. Enable the **Message Content** and **Server Members** privileged intents in the Developer Portal. Invite the bot with View Channels, Send Messages, Embed Links, and Read Message History permissions. The role command also needs Manage Roles.
7. Run the bot: `npm start`
8. Use `!task setchannel #your-task-channel` to restrict the bot to a specific channel (admin only)
9. Use `!task setup` in a project channel to create the live task board

## Storage

Kanban issues are stored in `server-tasks/{serverId}.json` files per server. A user's issues in one Discord server never appear on another server's board.
Configuration settings are stored in `server-configs/{serverId}.json` per server.
Live Kanban board message IDs are stored in `kanbanBoards.json`.
Data files are automatically added to .gitignore.
Set `BOT_DATA_DIR` to use a different storage folder. Set `BOT_ENV_FILE` to load the token from an existing `.env` file. Automatic deployments use these settings to share the original installation's data.

## Automatic deployment on a home server

The PM2 deployment process checks `origin/main` every 60 seconds using the server's existing Git access. It builds each changed commit in a separate release folder, installs locked production dependencies, runs syntax checks and tests, then restarts the bot. A deployment is accepted only after the bot logs into Discord. If startup fails, the preceding PM2 script is restored. Deployment does not change the working branch or overwrite the installation's `.env`, tasks, configuration, or live board IDs.

Requirements: Linux with `git`, `tar`, `flock`, Node.js 22 or newer, npm, PM2, and Git read access to this repository. Keep the bot token in the original installation's `.env` file.

Run once from the original bot folder, using the PM2 name of the existing bot. This also works when the original checkout is still on a feature branch:

```sh
git fetch origin main
mkdir -p .deploy/automation
printf '\n.deploy/\n' >> .git/info/exclude
git show origin/main:scripts/deploy.js > .deploy/automation/deploy.js
git show origin/main:scripts/watch-main.js > .deploy/automation/watch-main.js
BOT_REPO_DIR="$PWD" BOT_PM2_NAME=the-bot pm2 start .deploy/automation/watch-main.js --name rocky-deploy --kill-timeout 310000 --time
pm2 save
```

The watcher makes an initial deployment, then deploys future changes pushed or merged into `main`. Check it with `pm2 logs rocky-deploy`. To deploy once manually, run `BOT_REPO_DIR="$PWD" BOT_PM2_NAME=the-bot node .deploy/automation/deploy.js` while the watcher is stopped. `DEPLOY_INTERVAL_MS` can change the polling interval. PM2's startup service should be configured with `pm2 startup` so both processes return after a server reboot.

Prepared releases live under `.deploy/releases/`; the current and preceding releases are retained. The original installation stays available for recovery. GitHub Actions also checks pushes and pull requests against `main`.

## Checks

```sh
npm run check
npm test
```

Tests cover the claim/done flow, competing claims, permissions, the add/edit form, delete confirmation, import parsing, live board message syncing, Discord size limits, and deployment recovery. They use temporary data and fake PM2 processes.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club
