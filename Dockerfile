FROM python:3.8-slim

WORKDIR /app

COPY . .

RUN pip install -r requirements.txt

EXPOSE 3000

CMD ["python", "/app/bot.py"]
