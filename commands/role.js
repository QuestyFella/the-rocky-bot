const { PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'role',
    description: 'Mass-assign or remove a role from every member',
    async execute(message, args) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('You need Manage Roles permission.');
        }
        if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return message.reply('I am missing the Manage Roles permission.');
        }

        let role = message.mentions.roles.first();
        if (!role) {
            const idArg = args.find(a => /^\d{17,20}$/.test(a));
            role = idArg ? message.guild.roles.cache.get(idArg) : null;
        }
        if (!role) {
            return message.reply('Usage: `!task role all @Role` or `!task role all <roleID> [remove] [include-pending] [include-bots]`.');
        }
        if ((args[0] || '').toLowerCase() !== 'all') {
            return message.reply('Only `all` is supported right now. Usage: `!task role all @Role [remove] [include-pending] [include-bots]`.');
        }
        if (message.guild.members.me.roles.highest.position <= role.position) {
            return message.reply(`My highest role must be above **${role.name}** to manage it.`);
        }

        const remove = args.some(a => a.toLowerCase() === 'remove');
        const includePending = args.some(a => a.toLowerCase() === 'include-pending');
        const includeBots = args.some(a => a.toLowerCase() === 'include-bots');
        const statusMsg = await message.reply(`Working on ${remove ? 'removing' : 'adding'} **${role.name}** for everyone...`);
        await message.guild.members.fetch();

        const members = message.guild.members.cache.filter(member =>
            remove || ((includePending || member.pending !== true) && (includeBots || !member.user.bot))
        );
        const skippedPending = remove || includePending ? 0 : message.guild.members.cache.filter(member => member.pending === true).size;
        const skippedBots = remove || includeBots ? 0 : message.guild.members.cache.filter(member => member.user.bot).size;

        const results = await Promise.allSettled(
            members.map(member =>
                remove ? member.roles.remove(role, `Mass ${remove ? 'remove' : 'assign'} by ${message.author.tag}`)
                       : member.roles.add(role, `Mass ${remove ? 'remove' : 'assign'} by ${message.author.tag}`)
            )
        );
        const ok = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.length - ok;
        const skipped = [
            skippedPending ? `${skippedPending} pending/unverified skipped` : '',
            skippedBots ? `${skippedBots} bots skipped` : ''
        ].filter(Boolean).join(', ');
        return statusMsg.edit(`Done. ${ok} updated, ${failed} failed${skipped ? `, ${skipped}` : ''}.`);
    }
};
