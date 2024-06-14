const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const Docker = require('dockerode');
const winston = require('winston');

const docker = new Docker();

// Replace with your main bot token
const token = process.env.TELEGRAM_TOKEN || 'YOUR_MAIN_BOT_TOKEN';
const bot = new TelegramBot(token, { polling: true });

const userStates = {};
const deployedBots = {};

// Setup Winston logger
const logger = winston.createLogger({
  level: 'error',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log' })
  ]
});

// Handle /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Please provide the token of the bot you want to deploy.");
});

// Handle receiving text messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && !text.startsWith('/')) {
    if (!userStates[chatId]) {
      try {
        const isValidToken = await verifyToken(text);
        if (isValidToken) {
          userStates[chatId] = { token: text };
          bot.sendMessage(chatId, "Token is valid. Now send the bot code as a file.");
        } else {
          bot.sendMessage(chatId, "Invalid token. Please provide a valid token.");
        }
      } catch (error) {
        logger.error(`Token verification failed: ${error.message}`);
        bot.sendMessage(chatId, "An error occurred while verifying the token.");
      }
    }
  }
});

// Handle receiving documents
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;

  if (userStates[chatId] && msg.document.mime_type === 'text/x-python') {
    const token = userStates[chatId].token;
    const fileId = msg.document.file_id;
    const filePath = await bot.getFileLink(fileId);

    const codePath = `/tmp/${token}.py`;
    const writer = fs.createWriteStream(codePath);

    try {
      const response = await axios({
        url: filePath,
        method: 'GET',
        responseType: 'stream'
      });

      response.data.pipe(writer);

      writer.on('finish', async () => {
        try {
          const container = await deployBot(token, codePath);
          deployedBots[token] = container.id;
          bot.sendMessage(chatId, `Bot deployed with ID: ${container.id}`);
          delete userStates[chatId];
        } catch (error) {
          logger.error(`Bot deployment failed: ${error.message}`);
          bot.sendMessage(chatId, "An error occurred while deploying the bot.");
        }
      });

      writer.on('error', (error) => {
        logger.error(`File download failed: ${error.message}`);
        bot.sendMessage(chatId, 'Failed to download the file.');
        delete userStates[chatId];
      });
    } catch (error) {
      logger.error(`Failed to get file link: ${error.message}`);
      bot.sendMessage(chatId, 'An error occurred while downloading the file.');
    }
  } else {
    bot.sendMessage(chatId, "Please provide the bot token first.");
  }
});

// Command to list deployed bots
bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const botList = Object.entries(deployedBots).map(([token, id]) => `Token: ${token}, ID: ${id}`).join('\n');
  bot.sendMessage(chatId, botList || "No deployed bots.");
});

// Command to stop a deployed bot
bot.onText(/\/stop (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];

  if (deployedBots[token]) {
    try {
      const container = docker.getContainer(deployedBots[token]);
      await container.stop();
      bot.sendMessage(chatId, `Bot with token ${token} has been stopped.`);
    } catch (error) {
      logger.error(`Failed to stop bot: ${error.message}`);
      bot.sendMessage(chatId, "An error occurred while stopping the bot.");
    }
  } else {
    bot.sendMessage(chatId, "Bot not found.");
  }
});

// Command to delete a deployed bot
bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match[1];

  if (deployedBots[token]) {
    try {
      const container = docker.getContainer(deployedBots[token]);
      await container.remove({ force: true });
      delete deployedBots[token];
      bot.sendMessage(chatId, `Bot with token ${token} has been deleted.`);
    } catch (error) {
      logger.error(`Failed to delete bot: ${error.message}`);
      bot.sendMessage(chatId, "An error occurred while deleting the bot.");
    }
  } else {
    bot.sendMessage(chatId, "Bot not found.");
  }
});

async function verifyToken(token) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    return response.data.ok;
  } catch (error) {
    logger.error(`Token verification API error: ${error.message}`);
    return false;
  }
}

async function deployBot(token, codePath) {
  const port = process.env.PORT || 3000;

  const image = await docker.buildImage({
    context: __dirname,
    src: [codePath]
  }, { t: `bot_${token}` });

  return new Promise((resolve, reject) => {
    docker.modem.followProgress(image, (err, res) => err ? reject(err) : resolve(res), (event) => {
      console.log(event.stream);
    });
  }).then(() => {
    return docker.createContainer({
      Image: `bot_${token}`,
      Env: [`BOT_TOKEN=${token}`],
      name: `bot_${token}`,
      ExposedPorts: {
        '3000/tcp': {}
      },
      HostConfig: {
        PortBindings: {
          '3000/tcp': [{
            HostPort: `${port}`
          }]
        }
      }
    }).then(container => container.start());
  });
}

console.log('Bot is running...');
