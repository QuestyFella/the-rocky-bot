module.exports = {
    name: 'utter',
    async execute(message, args) {
        // This is a hidden command, so it should only be usable by the bot owner.
        if (message.author.id !== '824875613512400949') {
            return;
        }

        const messageToSend = args.join(' ');

        if (!messageToSend) {
            return;
        }

        await message.delete();

        if (message.reference) {
            try {
                const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                repliedMessage.reply(messageToSend);
            } catch (error) {
                console.error('Error fetching replied message:', error);
                // Fallback to sending in the channel if fetching fails
                message.channel.send(messageToSend);
            }
        } else {
            message.channel.send(messageToSend);
        }
    }
};