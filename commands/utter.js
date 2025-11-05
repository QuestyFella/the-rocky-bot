module.exports = {
    name: 'utter',
    execute(message, args) {
        // This is a hidden command, so it should only be usable by the bot owner.
        if (message.author.id !== '824875613512400949') {
            return;
        }

        const messageToSend = args.join(' ');

        if (!messageToSend) {
            return;
        }

        message.delete();
        message.channel.send(messageToSend);
    }
};