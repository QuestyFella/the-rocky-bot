# Kanban Board Discord Bot

A Discord bot for running a lightweight project Kanban board directly in Discord.

## Features

- Live-updating Kanban board using embeds
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

### Core Flow

- `!task` - Show the board once
- `!task setup` - Create a live-updating board in the current channel (Manage Guild only)
- `!task add [issue]` - Add an issue to the board
- `!task add Fix avionics @user by 2026-06-01` - Add and assign an issue with a due date
- `!task move [key] [todo|doing|review|done]` - Move an issue between columns
- `!task claim [key]` - Assign an issue to yourself
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
6. Invite your bot to your server with the necessary permissions (make sure to include "Administrator" permission for admin-only commands)
7. Run the bot: `npm start`
8. Use `!task setchannel #your-task-channel` to restrict the bot to a specific channel (admin only)
9. Use `!task setup` in a project channel to create a live Kanban board

## Storage

Kanban issues are stored in `server-tasks/{serverId}.json` files per server. A user's issues in one Discord server never appear on another server's board.
Configuration settings are stored in `server-configs/{serverId}.json` per server.
Live Kanban board message IDs are stored in `kanbanBoards.json`.
Data files are automatically added to .gitignore.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club
