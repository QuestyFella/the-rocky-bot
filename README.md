# Kanban Board Discord Bot

A Discord bot for running a lightweight project Kanban board directly in Discord.

## Features

- Live-updating Kanban board using embeds
- Buttons, task pickers, and an Add Task form
- Claim, Start Work, Release, and status changes without typing commands
- Available Tasks and My Tasks views, with pagination for larger boards
- To Do, In Progress, Review, and Done columns
- Short issue keys
- Issue assignment to users or roles
- Due dates and priorities
- Detailed issue embeds
- Optional channel restriction
- Mass role assignment / removal (`!task role all @Role [remove]`)
- Human verification on join — random emoji prompt that changes per person (stops bots)
- Persistent JSON storage
- Per-server board isolation, even when the same users are in multiple servers

## Commands

### Using the board

Run `!task` (or ask a server manager to run `!task setup` once for a live board).

1. Click **Add Task** to enter a title, description, priority, and optional due date. New tasks are unassigned.
2. Click **Available Tasks**, choose a task, and click **Claim** to assign yourself. **Start Work** also moves it to In Progress.
3. Click **My Tasks** to see your active work. Choose a task and use its status dropdown to move it to Review or Done.
4. Click **Release** to return your task to To Do for someone else to claim.

Task pickers and task controls opened from the board are visible only to the person who clicked. Buttons continue working after a restart. Tasks assigned to a role can be claimed by members of that role; a task already claimed by someone else cannot be taken over with Claim.

### Core Flow

- `!task` - Show the board once
- `!task setup` - Create a live-updating board in the current channel (Manage Guild only)
- `!task add [issue]` - Add an issue to the board
- `!task add Fix avionics @user by 2026-06-01` - Add and assign an issue with a due date
- `!task move [key] [todo|doing|review|done]` - Move an issue between columns
- `!task claim [key]` - Assign an issue to yourself
- `!task start [key]` - Claim and move an issue to In Progress
- `!task release [key]` / `!task unclaim [key]` - Return your issue to To Do
- `!task available` / `!task mine` - Browse available issues or your active work
- `!task done [key]` - Move an issue to Done
- `!task reopen [key]` - Move an issue back to To Do
- `!task refresh` - Manually refresh the live board (Manage Guild only)

### Issue Details

- `!task details [key]` - Show one issue as an embed
- `!task assign [key] @user|@role|none` - Change issue assignee
- `!task priority [key] [low|medium|high|urgent]` - Set issue priority
- `!task due [key] [date|none]` - Set or clear a due date
- `!task edit [key] [new title]` - Rename an issue
- `!task delete [key]` - Delete an issue

### Aliases

These run the same workflows as the commands above:

- `!task board` / `!task kanban` / `!task jira` / `!task list` / `!task show` - Show the board
- `!task status [key] [column]` - Same as `move`
- `!task close [key]` - Same as `done`
- `!task view [key]` - Same as `details`
- `!task rename [key] [new title]` - Same as `edit`
- `!task remove [key]` - Same as `delete`
- `!task duedate [key] [date|none]` - Same as `due`
- `!task commands` - Show the command list (same as `!task help` from the board module)

Column names also accept aliases, for example `wip`, `in-progress`, `testing`, `complete`, and `closed`.

### Add Options

When creating an issue, you can use flags or inline options:

- `!task add Fix avionics --unassigned` - Add without assigning to yourself
- `!task add Fix avionics --me` - Add and assign to yourself (new tasks are otherwise unassigned)
- `!task add Fix avionics --desc=Details here` - Add with a description
- `!task add Fix avionics --priority=high --status=doing` - Set priority and starting column
- `!task add Fix avionics priority:urgent column:review` - Inline priority/column syntax

Issue keys can be the project key (e.g. `QSS-1`), the internal task ID, or the issue's position on the sorted board.

### Setup

- `!task setchannel [add|remove|list] [#channel]` - Manage channels where the bot operates
- `!task role all @Role` - Mass-assign a role to non-pending, non-bot members in the server (Manage Roles)
- `!task role all @Role remove` - Mass-remove a role from everyone
- `!task verify setup #channel @Role` / `!task verify setup <channelID> <roleID>` - Set up emoji-type verification for new members (Manage Server)
- `!task verify status` - Show current verification config and pending prompts
- `!task verify off` - Disable verification
- `!task help` - Show help message

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Create a Discord bot application at the [Discord Developer Portal](https://discord.com/developers/applications)
4. Copy your bot token
5. Create a `.env` file in the root directory with the following content:
   ```
   DISCORD_TOKEN=your_bot_token_here
   ```
6. Enable the **Message Content** and **Server Members** privileged intents in the Developer Portal. Invite the bot with View Channels, Send Messages, Embed Links, and Read Message History permissions. Role and verification commands also need Manage Roles; verification cleanup needs Manage Messages.
7. Run the bot: `npm start`
8. Use `!task setchannel #your-task-channel` to restrict the bot to a specific channel (admin only)
9. Use `!task setup` in a project channel to create a live Kanban board

## Storage

Kanban issues are stored in `server-tasks/{serverId}.json` files per server. A user's issues in one Discord server never appear on another server's board.
Configuration settings are stored in `server-configs/{serverId}.json` per server.
Live Kanban board message IDs are stored in `kanbanBoards.json`.
Data files are automatically added to .gitignore.
Set `BOT_DATA_DIR` to use a different storage folder. Set `BOT_ENV_FILE` to load the token from an existing `.env` file. Automatic deployments use these settings to share the original installation's data.

## Automatic deployment on a home server

The PM2 deployment process checks `origin/main` every 60 seconds using the server's existing Git access. It builds each changed commit in a separate release folder, installs locked production dependencies, runs syntax checks and tests, then restarts the bot. A deployment is accepted only after the bot logs into Discord. If startup fails, the preceding PM2 script is restored. Deployment does not change the working branch or overwrite the installation's `.env`, tasks, configuration, or live board IDs.

Requirements: Linux with `git`, `tar`, `flock`, Node.js 22 or newer, npm, PM2, and Git read access to this repository. Keep the bot token in the original installation's `.env` file.

Run once from the original bot folder, using the PM2 name of the existing bot:

```sh
BOT_REPO_DIR="$PWD" BOT_PM2_NAME=the-bot pm2 start scripts/watch-main.js --name rocky-deploy --kill-timeout 310000
pm2 save
```

The watcher makes an initial deployment, then deploys future changes pushed or merged into `main`. Check it with `pm2 logs rocky-deploy`. To deploy once manually, run `BOT_REPO_DIR="$PWD" BOT_PM2_NAME=the-bot npm run deploy` while the watcher is stopped. `DEPLOY_INTERVAL_MS` can change the polling interval. PM2's startup service should be configured with `pm2 startup` so both processes return after a server reboot.

Prepared releases live under `.deploy/releases/`; the current and preceding releases are retained. The original installation stays available for recovery. GitHub Actions also checks pushes and pull requests against `main`.

## Checks

```sh
npm run check
npm test
```

Tests cover self-assignment, competing claims, permissions, server isolation, component limits, pagination, task creation, storage failures, and deployment recovery. They use temporary data and fake PM2 processes.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club
