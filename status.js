const { ActivityType } = require('discord.js');

function setCustomStatus(client, type, name) {
  if (!client || !client.user) return;

  let activityType = type;
  if (typeof type === 'string') {
    activityType = ActivityType[type] !== undefined ? ActivityType[type] : ActivityType.Watching;
  }

  try {
    client.user.setPresence({
      status: 'online',
      activities: [
        {
          name: name || 'addslice.com',
          type: activityType || ActivityType.Watching,
        },
      ],
    });
  } catch (err) {
    // ignore errors setting presence
    console.error('Failed to set presence:', err.message);
  }
}

function setBotStatus(client) {
  setCustomStatus(client, ActivityType.Watching, 'addslice.com');
}

module.exports = {
  setBotStatus,
  setCustomStatus,
};
