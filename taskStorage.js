const fs = require('fs');
const path = require('path');

class TaskStorage {
    constructor(tasksDir = './server-tasks') {
        this.tasksDir = tasksDir;
        this.ensureDirectoryExists();
        this.updateListener = null;
    }

    setUpdateListener(callback) {
        this.updateListener = callback;
    }

    ensureDirectoryExists() {
        if (!fs.existsSync(this.tasksDir)) {
            fs.mkdirSync(this.tasksDir, { recursive: true });
        }
    }

    getFilePath(guildId) {
        return path.join(this.tasksDir, `${guildId}.json`);
    }

    ensureFileExists(guildId) {
        this.ensureDirectoryExists();
        const filePath = this.getFilePath(guildId);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify([]), 'utf8');
        }
    }

    loadTasks(guildId) {
        this.ensureFileExists(guildId);
        try {
            const filePath = this.getFilePath(guildId);
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`Error loading tasks for guild ${guildId}:`, error);
            return [];
        }
    }

    saveTasks(guildId, tasks) {
        try {
            const filePath = this.getFilePath(guildId);
            fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2), 'utf8');
            if (this.updateListener) {
                this.updateListener(guildId);
            }
            return true;
        } catch (error) {
            console.error(`Error saving tasks for guild ${guildId}:`, error);
            return false;
        }
    }

    addTask(guildId, task) {
        const tasks = this.loadTasks(guildId);
        tasks.push(task);
        return this.saveTasks(guildId, tasks);
    }

    updateTask(guildId, taskId, updatedTask) {
        const tasks = this.loadTasks(guildId);
        const index = tasks.findIndex(task => task.id === taskId);
        if (index !== -1) {
            tasks[index] = updatedTask;
            return this.saveTasks(guildId, tasks);
        }
        return false;
    }

    deleteTask(guildId, taskId) {
        const tasks = this.loadTasks(guildId);
        const index = tasks.findIndex(task => task.id === taskId);
        if (index !== -1) {
            tasks.splice(index, 1);
            return this.saveTasks(guildId, tasks);
        }
        return false;
    }

    getAllTasks(guildId) {
        return this.loadTasks(guildId);
    }

    getUserTasks(guildId, userId) {
        const allTasks = this.loadTasks(guildId);
        return allTasks.filter(task => task.userId === userId);
    }

    getTaskIndex(guildId, taskId) {
        const tasks = this.loadTasks(guildId);
        return tasks.findIndex(task => task.id === taskId);
    }

    getRoleTasks(guildId, roleId) {
        const allTasks = this.loadTasks(guildId);
        return allTasks.filter(task => task.assignedToRole === roleId);
    }
}

module.exports = TaskStorage;