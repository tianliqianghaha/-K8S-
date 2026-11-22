# scripts 目录说明

> 每个文件的用途、对应文档章节、以及它是"部署用"还是"验证用"。
> 文档里引用的路径都在这里，照着章节走就能复现。

---

## app/ —— 本章实验的源码

```
app/gateway/main.py          云端 gateway
  用途   鉴权（API Key）、限流（滑动窗口）、幂等（Idempotency-Key）、
         任务队列、通过 WebSocket 派发、把 Agent 回传的 token 转成 SSE
  部署   第 3 章 3.3，做成 ConfigMap 挂进 Pod，启动时 pip install fastapi uvicorn
  依赖   环境变量 API_KEYS / RATE_LIMIT / TASK_TIMEOUT

app/agent/main.py            本地 Agent
  用途   主动反连云端 /agent，收任务后调本地 vLLM 流式接口，逐 token 回传；
         断线指数退避重连；已完成的 task_id 幂等；未完成任务重连后 resume
  部署   第 3 章 3.6，systemd 托管（不在 K8S 里，理由见第 6 章第 22 条）
  依赖   aiohttp、websockets；环境变量 GATEWAY_WS / VLLM_URL / MAX_CONCURRENT

app/exporter/gpu_exporter.py  GPU 指标导出器
  用途   轮询 nvidia-smi，暴露 Prometheus 文本格式（显存/利用率/温度/功耗）
         替代在 WSL 里起不来的 DCGM
  部署   第 5 章 3.2，systemd 托管，监听 9101
  注意   WSL 的 nvidia-smi 在 /usr/lib/wsl/lib/ 下，单元里要补 PATH

app/bench/gw_bench.py        压测脚本
  用途   经公网全链路测 1/4/8/16 并发的延迟与吞吐，顺带验证限流 429
  用法   /home/k8s/agent/venv/bin/python gw_bench.py
  产出   第 3 章闸门②那张并发曲线

app/dashboard.json           Grafana 大盘
  用途   6 个面板：GPU 利用率 / 显存 / Kueue 队列深度 / 温度功耗 /
         请求数 / 首字延迟 P99 / prefix cache 命中率
  导入   第 5 章 3.4，POST 到 Grafana 的 /api/dashboards/db
```

---

## local/ —— Windows 与 WSL 侧的安装脚本

```
00_enable-wsl2.ps1           启用两个 Windows 功能 + 关快速启动（管理员）
                             对应第 1 章第二节

01_install-wsl.ps1           早期方案：走 winget 装 WSL（国内不可用，仅存档）
                             实际有效路径是 04 + 05，见第 1 章第三、四节

02_wsl-init.sh               GPU 工具链 + containerd 双 runtime + kubelet
                             对应第 1 章第六节，在 WSL 里以 k8s 用户执行

03_fix-hypervisor.ps1        修复"启用了功能但 Hypervisor 没起来"
                             对应第 6 章第 1 条

04_install-wsl-from-msix.ps1 用 msixbundle 注册 WSL 平台（需管理员）
                             对应第 1 章第三节

05_import-ubuntu.ps1         导入 .wsl 镜像到 C:\WSL\Ubuntu-24.04
                             对应第 1 章第四节

06_setup-user.sh             建 k8s 用户、换清华源、开 systemd、写默认用户
                             对应第 1 章 5.2

10_all-in-one.ps1            把 05+06+02 串起来跑（首次搭建时的便捷入口）
                             WSL 被沙箱拦截那段时间的产物，现在可直接按章节手工执行

wslconfig.template           .wslconfig 模板（11G 内存 / 8 核 / 8G swap）
                             对应第 1 章 5.1

一键运行.bat                 调用 10_all-in-one.ps1（纯 ASCII，避免编码问题）
```

---

## 不在本目录但被文档引用的

```
~/.workbuddy/skills/aliyun-ecs-one-liner/     阿里云开机器技能
  scripts/cli.py                              preflight / plan / create
  assets/hk-ai-cp.template.json               4C8G 抢占模板
  第 2 章第一节

远端（部署后存在于云端或本地）
  /etc/systemd/system/vllm.service            第 3 章 3.5
  /etc/systemd/system/ai-agent.service        第 3 章 3.6
  /etc/systemd/system/gpu-exporter.service    第 5 章 3.2
  /etc/systemd/system/gpu-exporter-tunnel.service
  K8S 侧的 YAML 全部内联在文档里，可直接复制执行
```

---

## 复现顺序

```
1. local/00 → 重启 → 确认 Hypervisor Present
2. 手工下 msixbundle + Add-AppxPackage（04 描述的就是这一步）
3. 手工下 .wsl 镜像 + wsl --import（05 的内联命令）
4. local/06 → wsl --shutdown → 05 的常驻客户端
5. local/02 → 三道闸门验收
6. 第 2 章：开机器 → kubeadm → Cilium → device plugin → join
7. 第 3 章：app/gateway + app/agent 部署 → 四道闸门
8. 第 4 章：资源语义验证（先腾卡，做完恢复）
9. 第 5 章：治理平面（监控必须按参数装）
```

每一步的预期输出都写在对应章节里，对照不上就停下查第 6 章。
