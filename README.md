# Task Manager Discord Bot

A Discord bot that allows users to manage their tasks directly from Discord, originally created for the UofG Rocketry Club because I was bored 😄

## Features

- Add new tasks
- List all tasks
- Mark tasks as complete/incomplete
- Delete tasks
- Edit task descriptions
- Set due dates for tasks with automatic reminders
- Clear completed tasks
- Detailed issue views with embeds
- Jira-style Kanban board using embeds
- Live-updating board message with To Do, In Progress, Review, and Done columns
- Persistent storage of tasks
- User-specific task management
- Assign tasks to other users (admin only)
- Assign tasks to all members of a role (admin only)
- Remove tasks from all members of a role (admin only)
- List tasks assigned to roles (admin only)
- Restrict bot to specific channel (admin only)
- Automatic due date reminders
- Multi-server support

## Commands

### Kanban Board

- `!task jira setup` - Create a live-updating Kanban board in the current channel (Manage Guild only)
- `!task jira` - Show the Kanban board once
- `!task jira add [issue]` - Add an issue to the board
- `!task jira add Fix avionics @user by 2026-06-01` - Add and assign an issue with a due date
- `!task jira move [key] [todo|doing|review|done]` - Move an issue between columns
- `!task jira claim [key]` - Assign an issue to yourself
- `!task jira assign [key] @user` - Assign an issue to a user
- `!task jira priority [key] [low|medium|high|urgent]` - Set issue priority
- `!task jira due [key] [date|none]` - Set or clear a due date
- `!task jira details [key]` - Show one issue as an embed
- `!task board` / `!task kanban` - Aliases for `!task jira`

### Personal Tasks

- `!task add [task]` - Add a task to yourself
- `!task new` - Create a task interactively
- `!task view [@user]` - View your tasks, or another user's tasks as an admin
- `!task complete [number]` - Mark one of your tasks as complete
- `!task delete [number]` - Delete one of your tasks
- `!task edit [number] [description]` - Edit a task description
- `!task duedate [number] [date]` - Set a due date for a task
- `!task clear` - Clear completed tasks
- `!task remindme [message] in [time]` - Set a reminder
- `!task remindme [list|view|delete]` - Manage reminders

### Admin

- `!task assign @user [task]` - Assign a task to another user
- `!task assignrole @role [task]` - Assign a task to all members of a role
- `!task listrole @role` - List tasks assigned to a role
- `!task removerole @role` - Remove all tasks assigned to a role
- `!task setchannel [add|remove|list] [#channel]` - Manage channels where the bot operates
- `!task delete @user [number]` - Delete another user's task
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
9. The bot checks due-date summaries at midnight and noon
10. Use `!task jira setup` in a project channel to create a live Kanban board

## Storage

Tasks and Kanban issues are stored together in `server-tasks/{serverId}.json` files per server. The bot will create these automatically.
Configuration settings are stored in `server-configs/{serverId}.json` per server.
Live Kanban board message IDs are stored in `jiraBoards.json`.
Data files are automatically added to .gitignore.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club
