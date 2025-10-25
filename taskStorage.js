const fs = require('fs');
const path = require('path');

class TaskStorage {
    constructor(filePath = './tasks.json') {
        this.filePath = filePath;
        this.ensureFileExists();
    }

    ensureFileExists() {
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify([]), 'utf8');
        }
    }

    loadTasks() {
        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error loading tasks:', error);
            return [];
        }
    }

    saveTasks(tasks) {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), 'utf8');
            return true;
        } catch (error) {
            console.error('Error saving tasks:', error);
            return false;
        }
    }

    addTask(task) {
        const tasks = this.loadTasks();
        tasks.push(task);
        return this.saveTasks(tasks);
    }

    updateTask(taskId, updatedTask) {
        const tasks = this.loadTasks();
        const index = tasks.findIndex(task => task.id === taskId);
        if (index !== -1) {
            tasks[index] = updatedTask;
            return this.saveTasks(tasks);
        }
        return false;
    }

    deleteTask(taskId) {
        const tasks = this.loadTasks();
        const index = tasks.findIndex(task => task.id === taskId);
        if (index !== -1) {
            tasks.splice(index, 1);
            return this.saveTasks(tasks);
        }
        return false;
    }

    getAllTasks() {
        return this.loadTasks();
    }

    getUserTasks(userId) {
        const allTasks = this.loadTasks();
        return allTasks.filter(task => task.userId === userId);
    }

    getTaskIndex(taskId) {
        const tasks = this.loadTasks();
        return tasks.findIndex(task => task.id === taskId);
    }

    clearAllTasks() {
        return this.saveTasks([]);
    }
}

module.exports = TaskStorage;