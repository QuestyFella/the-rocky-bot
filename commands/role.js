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
            return message.reply('Usage: `!task role all @Role` or `!task role all <roleID> [remove]`.');
        }
        if ((args[0] || '').toLowerCase() !== 'all') {
            return message.reply('Only `all` is supported right now. Usage: `!task role all @Role [remove]`.');
        }
        if (message.guild.members.me.roles.highest.position <= role.position) {
            return message.reply(`My highest role must be above **${role.name}** to manage it.`);
        }

        const remove = args.some(a => a.toLowerCase() === 'remove');
        const statusMsg = await message.reply(`Working on ${remove ? 'removing' : 'adding'} **${role.name}** for everyone...`);
        await message.guild.members.fetch();

        const results = await Promise.allSettled(
            message.guild.members.cache.map(member =>
                remove ? member.roles.remove(role, `Mass ${remove ? 'remove' : 'assign'} by ${message.author.tag}`)
                       : member.roles.add(role, `Mass ${remove ? 'remove' : 'assign'} by ${message.author.tag}`)
            )
        );
        const ok = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.length - ok;
        return statusMsg.edit(`Done. ${ok} updated, ${failed} failed (usually members above me in hierarchy).`);
    }
};
