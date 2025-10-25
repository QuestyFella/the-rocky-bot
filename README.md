# Task Manager Discord Bot

A Discord bot that allows users to manage their tasks directly from Discord, originally created for the UofG Rocketry Club because I was bored 😄

## Features

- Add new tasks
- List all tasks
- Mark tasks as complete/incomplete
- Delete tasks
- Edit task descriptions
- Set due dates for tasks
- Clear completed tasks
- Detailed view of tasks with embeds
- Persistent storage of tasks
- User-specific task management

## Commands

- `!task add [task]` - Add a new task
- `!task list` - List all your tasks in text format
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
6. Invite your bot to your server with the necessary permissions
7. Run the bot: `npm start`

## Storage

Tasks are stored in a `tasks.json` file in the root directory. The bot will automatically create this file if it doesn't exist.

## Contributing

Feel free to fork this repository and submit pull requests for improvements or bug fixes.

Made with ❤️ for the University of Guelph Rocketry Club