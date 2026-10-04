# Kanban Board Discord Bot

A Discord bot for running a lightweight project Kanban board directly in Discord.

## Features

- Live-updating Kanban board using embeds
- Every unlocked task appears on the board, grouped by title tags with an overview and linked messages
- Prerequisite tasks unlock dependent work automatically; managers can review blocked tasks privately
- Buttons, task pickers, and Add Task / Edit Task forms
- Import a pasted list or text file, review a preview, then save the whole batch
- Claim, Start Work, Release, and status changes without typing commands
- Available Tasks and My Tasks views, with pagination for larger boards
- Visible team labels that stay with tasks after assignment, plus a Team Tasks picker for any group
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

1. Anyone can click **Add Task** to enter a title, description, priority, optional due date, and team. New tasks are unassigned.
2. Click **Available Tasks**, choose a task, and click **Claim** to assign yourself. **Start Work** also moves it to In Progress.
3. Click **My Tasks** to see your active work. Choose a task and use its status dropdown to move it to Review or Done.
4. Click **Release** to return your task to To Do for someone else to claim.
5. Click **Team Tasks**, choose a group, and see its active tasks, including tasks claimed by teammates.
6. Click **Edit Task** in a task's details to change its title, description, priority, due date, or prerequisites. The form is prefilled; leaving description, due date, or prerequisites blank clears it. The creator, assignee, and server managers can edit unlocked tasks, as can members of an explicitly assigned role.

The shared board shows Add Task, Available Tasks, My Tasks, Team Tasks, and More. **More** opens a private menu: everyone sees Browse Tasks and Add Task; members with **Administrator** or **Manage Server** permission also see Import Tasks, Setup Teams, Refresh Board, and Blocked Tasks. Task controls appear only when you can use them. Permissions are checked again when you click or save, including on older messages.

The live board groups tasks by the **[TAG]** at the start of their title, such as `[POWER] Check the battery pack` or `[STM32] Pin map`. Tags ignore case and extra spaces. Tasks without a tag appear under **General**. Tags describe the work; the separate **Team** label still shows which group it is meant for.

With multiple tags, a short overview shows task counts, progress, and **View tasks** links to each group. Each group has its own message with the tag and team at the top, followed by task cards showing the full title, status, priority, due date, and owner. If a group contains different teams, each task shows its own team. **Open Tasks** opens a private task picker for that tag, including completed tasks. Add or change a `[TAG]` prefix through **Add Task** or **Edit Task** to move a task into a group.

Large groups continue across linked messages so every unlocked task remains visible. Previous/Next group links and an Overview link connect them. Task changes update the affected messages; adding a group keeps existing group links, and a deleted message is recreated automatically. **Refresh Board** forces every message to refresh.

Task pickers and task controls opened from the board are visible only to the person who clicked. Task pages show 10 entries with full titles, team, priority, status, and due date above the dropdown. Choose a task to read its full description and use its controls. Buttons continue working after a restart. Tasks assigned to a role can be claimed by members of that role; a task already claimed by someone else cannot be taken over with Claim. Edit forms expire after 15 minutes or a restart, and detect changes to task details made while the form was open. Assignment, status, and team changes made during an edit are preserved.

### Blocking tasks with prerequisites

1. Open a task and click **Edit Task**.
2. In **Blocked by**, enter task keys or whole tags separated by commas, such as `URC-12, [POWER], [GROUND STATION]`. These tasks and tags can belong to any team in the same server. You can enter up to 20 prerequisites; each tag counts as one.
3. Save. An unfinished task stays blocked until **every** prerequisite is **Done**. It then appears on the board and becomes available to claim automatically. Leave the field blank to remove its prerequisites.

A tag prerequisite requires **every current task in that tag** to be Done, including blocked tasks. Tag names ignore case and extra spaces. The private blocked-task view shows tag progress, such as **3/5 Done**. Tags stay linked to their current tasks: adding a task, moving an unfinished task into the tag, or reopening a task blocks unfinished dependent work again. Moving a task out of the tag removes it from that prerequisite. An empty or missing tag keeps work blocked until tasks are added to it or a manager removes the prerequisite.

The shared board hides blocked tasks for everyone. Members also cannot see them in Browse Tasks, My Tasks, Team Tasks, or through old task controls. Members with **Administrator** or **Manage Server** permission can open **More → Blocked Tasks** to review and edit them privately. Managers' private Browse Tasks and Team Tasks views also include blocked work, labeled with what it is waiting on. A member who adds unfinished prerequisites to their task will need a server manager to edit it again until it unlocks.

Blocked tasks cannot be claimed, started, or moved to Review or Done, including through text commands. Reopening a prerequisite blocks its unfinished dependent tasks again; completed work keeps its history. Deleting a prerequisite leaves dependent tasks blocked until a manager removes that reference. Self references, a task's own tag, unknown tasks or tags, and circular dependencies are rejected. Title edits also check for cycles when moving tasks between tags.

The text command `!task depends URC-20 URC-12, [POWER]` sets prerequisites; `!task depends URC-20 none` clears them. To wait for a whole category, use `!task depends URC-20 [STM32]`. Blocked task details stay in the private button workflow. Existing tasks start with no prerequisites; configure the relationships you want through Edit Task.

### Setting up teams

1. A member with **Manage Server** permission opens `!task`, clicks **More**, **Setup Teams**, then **Edit Teams**. `!task teams setup` opens the same setup controls.
2. Enter one group name per line (for example, Avionics, Software, and Mechanical), then submit the form.
3. **Add Task** now includes a team dropdown. Existing tasks have a **Change team tag** dropdown for their creator, assignee, or a server manager.

Each task has one optional team label, shown on the board, in task pickers, and in its details. It indicates which group the task is meant for. Teams need no Discord roles or membership setup; anyone can browse any team. Claiming, starting, releasing, or reassigning a task keeps its label. A label allows any member to claim an available task; existing ownership and explicit role-assignment permissions still apply.

Older team tags and role-assigned tasks remain visible in **Team Tasks**, and their label is retained when someone claims them. Removing a team from setup keeps existing task labels and their browse view. Select **No team** on a task to clear its label. Team setup supports up to 24 names per server, each up to 50 characters. Reordering names keeps their task links; changing a name creates a new team, while the previous name remains on existing tasks.

### Importing a task list

1. A member with **Administrator** or **Manage Server** permission clicks **More**, then **Import Tasks**. Paste a short list, or upload the full list as a UTF-8 `.txt` or `.md` file. Use one input at a time. The form uses Discord's [file upload component](https://docs.discord.com/developers/components/reference#file-upload).
2. Review the preview. Previous/Next shows each task's fields, and the attached preview file contains every entry and its full description.
3. Click **Import Tasks** in the preview to save the batch. **Cancel** discards it. Tasks start unassigned in To Do, attributed to the person who imports them.

Managers can also attach a text file to a message containing `!task import`, or paste a short list after that command. Only the person who submitted a list can confirm or cancel it, in the same server and channel. Confirmation checks that they still have manager permission. Anyone can continue creating individual tasks with Add Task.

Use this format; blank descriptions are allowed. Numbering and section headings are optional:

```text
HAB-1 TASKS (2)
Fields per task: Title / Description / Priority / Due date / Team

========================================
STM32
========================================

1.
Title: [STM32] Pin map and SPI bus assignment
Description: Add a mutex if tasks share a bus.
Priority: high
Due date: 2026-10-12
Team: Cubesat

2.
Title: [STM32] Watchdog and reset-cause logging
Description:
Priority: high
Due date: 2026-10-12
Team: Cubesat
```

Team names match configured labels regardless of capitalization. Add unknown names using **Setup Teams** before importing. Only Title is required; omitted fields default to an empty description, medium priority, no due date, and no team. Descriptions can span several lines. Dates must be real calendar dates in `YYYY-MM-DD` format; blank or `none` clears an optional date or team.

An import supports up to 250 tasks in a 256 KiB file; pasted form text supports 4,000 characters. Invalid entries block the whole import. Existing tasks with the same title and team are skipped, preserving their details and ownership. Duplicate entries in a file are skipped; repeated titles for the same team with conflicting details must be corrected. A confirmation checks for new duplicates again and saves all new tasks together. Previews expire after 15 minutes or a bot restart; submitting a new list replaces your preceding preview.

### Core Flow

- `!task` - Show the board once
- `!task setup` - Create a live-updating board in the current channel (Manage Guild only)
- `!task add [issue]` - Add an issue to the board
- `!task import` - Open import instructions, or preview an attached text file / pasted list
- `!task add Fix avionics @user by 2026-06-01` - Add and assign an issue with a due date
- `!task move [key] [todo|doing|review|done]` - Move an issue between columns
- `!task claim [key]` - Assign an issue to yourself
- `!task start [key]` - Claim and move an issue to In Progress
- `!task release [key]` / `!task unclaim [key]` - Return your issue to To Do
- `!task available` / `!task mine` - Browse available issues or your active work
- `!task teams` / `!task teamtasks` / `!task myteams` - Choose a team and browse its active issues
- `!task done [key]` - Move an issue to Done
- `!task reopen [key]` - Move an issue back to To Do
- `!task refresh` - Manually refresh the live board (Manage Guild only)

### Issue Details

- `!task details [key]` - Show one issue as an embed
- `!task assign [key] @user|@role|none` - Change issue assignee
- `!task team [key] Team Name|none` - Set or clear the team label (names can contain spaces)
- `!task priority [key] [low|medium|high|urgent]` - Set issue priority
- `!task due [key] [date|none]` - Set or clear a due date
- `!task depends [key] OTHER-1, [TAG]|none` - Set or clear prerequisite tasks and whole tags
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
- `!task teams setup` - Enter group names to use as team labels (Manage Server)
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

Tests cover self-assignment, competing claims, permissions, server isolation, team setup and filtering, tags surviving assignment, component limits, pagination, native modal submissions and file uploads, bulk import parsing and confirmation, duplicate handling, storage failures, and deployment recovery. They use temporary data and fake PM2 processes.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club
