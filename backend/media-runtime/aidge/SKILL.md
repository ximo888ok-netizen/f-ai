# Aidge 虚拟试穿

依次使用已授权的模特图和服装图。执行器运行本目录的 run.py，将两张图片临时保存到部署方 OSS，调用 VirtualTryOn 后轮询 QueryAsyncTaskResult，把实际成品保存为 PNG。输入要求和接口字段以[官方文档](https://help.aliyun.com/zh/aidge/api-aidge-2026-04-28-virtualtryon)为准。
