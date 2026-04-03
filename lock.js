const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function createLockModule({ lockManagerRoleIds, lockChannelId, lockedOutRoleId }) {
  const canManageLocks = lockManagerRoleIds instanceof Set && lockManagerRoleIds.size > 0;
  const isConfigured = canManageLocks && Boolean(lockChannelId) && Boolean(lockedOutRoleId);

  if (!isConfigured) {
    console.warn(
      '[LOCK] lock command is disabled. Set LOCK_MANAGER_ROLE_IDS, LOCK_CHANNEL_ID and LOCKED_ROLE_ID to enable it.'
    );
  }

  function buildCommands() {
    if (!isConfigured) {
      return [];
    }

    return [
      new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock configured channel for the configured role.'),
      new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock configured channel for the configured role.'),
    ];
  }

  async function handleInteraction(interaction) {
    if (interaction.commandName !== 'lock' && interaction.commandName !== 'unlock') {
      return false;
    }

    if (interaction.commandName === 'lock') {
      await handleLockCommand(interaction);
      return true;
    }

    await handleUnlockCommand(interaction);
    return true;
  }

  async function handleLockCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    if (!interaction.member || !interaction.member.roles || !interaction.member.roles.cache) {
      await interaction.reply({
        content: 'Could not validate your server roles.',
        flags: 64,
      });
      return;
    }

    const isAllowed = [...lockManagerRoleIds].some((roleId) => interaction.member.roles.cache.has(roleId));
    if (!isAllowed) {
      await interaction.reply({
        content: 'You are not allowed to use /lock.',
        flags: 64,
      });
      return;
    }

    const guild = interaction.guild;
    const channel = await guild.channels.fetch(lockChannelId).catch(() => null);

    if (!channel || !channel.isTextBased() || !channel.permissionOverwrites) {
      await interaction.reply({
        content: 'Configured lock channel was not found or is not a text channel.',
        flags: 64,
      });
      return;
    }

    await channel.permissionOverwrites.edit(
      lockedOutRoleId,
      {
        SendMessages: false,
        SendMessagesInThreads: false,
      },
      {
        reason: `Locked by ${interaction.user.tag} (${interaction.user.id})`,
      }
    );

    const lockEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Channel Locked')
      .setDescription(`Role <@&${lockedOutRoleId}> can no longer send messages in this channel.`)
      .addFields({ name: 'Locked By', value: `<@${interaction.user.id}>`, inline: true })
      .setTimestamp(new Date());

    await channel.send({
      embeds: [lockEmbed],
      allowedMentions: { parse: [] },
    });

    await interaction.reply({
      content: `Locked <#${lockChannelId}> for <@&${lockedOutRoleId}>.`,
      flags: 64,
      allowedMentions: { parse: [] },
    });
  }

  async function handleUnlockCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        flags: 64,
      });
      return;
    }

    if (!interaction.member || !interaction.member.roles || !interaction.member.roles.cache) {
      await interaction.reply({
        content: 'Could not validate your server roles.',
        flags: 64,
      });
      return;
    }

    const isAllowed = [...lockManagerRoleIds].some((roleId) => interaction.member.roles.cache.has(roleId));
    if (!isAllowed) {
      await interaction.reply({
        content: 'You are not allowed to use /unlock.',
        flags: 64,
      });
      return;
    }

    const guild = interaction.guild;
    const channel = await guild.channels.fetch(lockChannelId).catch(() => null);

    if (!channel || !channel.isTextBased() || !channel.permissionOverwrites) {
      await interaction.reply({
        content: 'Configured lock channel was not found or is not a text channel.',
        flags: 64,
      });
      return;
    }

    await channel.permissionOverwrites.edit(
      lockedOutRoleId,
      {
        SendMessages: true,
        SendMessagesInThreads: true,
      },
      {
        reason: `Unlocked by ${interaction.user.tag} (${interaction.user.id})`,
      }
    );

    const unlockEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Channel Unlocked')
      .setDescription(`Role <@&${lockedOutRoleId}> is now allowed to send messages in this channel.`)
      .addFields({ name: 'Unlocked By', value: `<@${interaction.user.id}>`, inline: true })
      .setTimestamp(new Date());

    await channel.send({
      embeds: [unlockEmbed],
      allowedMentions: { parse: [] },
    });

    await interaction.reply({
      content: `Unlocked <#${lockChannelId}> for <@&${lockedOutRoleId}> with send-message permission enabled.`,
      flags: 64,
      allowedMentions: { parse: [] },
    });
  }

  return {
    buildCommands,
    handleInteraction,
  };
}

module.exports = {
  createLockModule,
};