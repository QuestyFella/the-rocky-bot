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
- Detailed view of tasks with embeds
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

- `!task add [task]` - Add a new task
- `!task assign @user [task]` - Assign a task to another user (admin only)
- `!task assignrole @role [task]` - Assign a task to all members of a role (admin only)
- `!task listrole @role` - List tasks assigned to a role (admin only)
- `!task removerole @role` - Remove all tasks assigned to a role (admin only)
- `!task setchannel #channel` - Set the channel where the bot operates (admin only)
- `!task list` - List all your tasks in text format
- `!task assigned` - List tasks assigned to you by others
- `!task detailed` - Show detailed view of all tasks with embeds
- `!task complete [number]` - Mark a task as complete
- `!task delete [number]` - Delete a task
- `!task edit [number] [description]` - Edit a task description
- `!task duedate [number] [date]` - Set a due date for a task
- `!task clear` - Clear all completed tasks
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
9. The bot will send due date reminders automatically at midnight each day

## Storage

Tasks are stored in `server-tasks/{serverId}.json` files per server. The bot will create these automatically.
Configuration settings are stored in `server-configs/{serverId}.json` per server.
Data files are automatically added to .gitignore.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club