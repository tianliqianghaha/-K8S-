# scripts · 干净部署脚本

> 本目录只放**能照着一次跑通**的脚本。每个脚本都是幂等的（重复执行不会搞坏），
> 每个都对应正文某一章，章号写在文件头注释里。

## 一、这一批（第 7~9 章，13~15 册）

执行顺序即下表顺序。所有脚本以 `cp-1`（控制面）为执行入口，凡是需要在 infra-01 上跑的会注明。

```
顺序  脚本                              对应章节            在哪台执行     做什么
─────────────────────────────────────────────────────────────────────────────────────────
 1   s19-sealed-secrets.sh              13 第7章 13.3       cp-1          装控制器 + 取公钥 + 备份私钥
 2   s20-seal-secrets.py                13 第7章 13.4       cp-1          加密/迁移 Secret（带自动回滚）
 3   s21-coredns-hosts.yaml             14 第8章 14.2       cp-1          给 CoreDNS 加内部域名
 4   s22-blackbox-values.yaml           14 第8章 14.3       cp-1          blackbox helm values（3 个 CA 模块）
 5   s23-probes.yaml                    14 第8章 14.4       cp-1          7 个 Probe
 6   s24-rules.yaml                     14 第8章 14.6       cp-1          15 条探针/SLO/容量规则
 7   s25-etcd-metrics.sh                14 第8章 14.5       cp-1/cp-2/cp-3  逐个开 etcd metrics 监听
 8   s26-etcd-reload.sh                 14 第8章 14.5       同上           让 kubelet 真正重读清单
 9   s27-alert-routing.sh               14 第8章 14.7       cp-1          P1/P2/P3 三级路由
10   s28-grafana-dashboard.py            14 第8章 14.8       cp-1          生成 8 面板看板 ConfigMap
11   s29-longhorn-recurring.yaml         15 第9章 15.2       cp-1          快照/备份策略
12   s30-etcd-restore-verify.sh          15 第9章 15.4       cp-1          etcd 快照恢复验证
13   infra-alert-receiver.py             14 第8章 14.7       infra-01      告警接收端（/p1 /p2 /p3）
```

## 二、执行方式（统一模式）

由于脚本写在 Windows，传到 Linux 会带 `\r`，**每次 scp 后必须先去掉**：

```bash
scp -i id_k8s s19-sealed-secrets.sh root@<cp-1公网>:/root/s19.sh
ssh -i id_k8s root@<cp-1公网> "sed -i 's/\r$//' /root/s19.sh; bash /root/s19.sh"
```

批量用 Python 驱动时（本项目的 `fleet.py`）：

```python
import fleet
h = fleet.by_name("cp-1")
fleet.scp("s19-sealed-secrets.sh", "/root/s19.sh", h)
rc, out = fleet.ssh(h, "sed -i 's/\\r$//' /root/s19.sh; bash /root/s19.sh", timeout=900)
```

## 三、这一批脚本里必须知道的四个前提

```
① s19 用的是新仓库地址
   https://bitnami.github.io/sealed-secrets
   旧的 bitnami-labs.github.io 已 404，helm repo add 会失败

② s22 依赖一个已存在的 Secret：monitoring/blackbox-probe-ca
   里面要放三个 CA（集群内部 CA / 集群 CA / Dex 自签 CA），建法见 14.3

③ s23 里的 NodePort 是硬编码的（32691 / 31559）
   如果 Gateway 被重建过，NodePort 会变，先查再改：
   kubectl -n envoy-gateway-system get svc -o wide | grep NodePort

④ s30 会占 200MB 磁盘并起一个临时 etcd
   跑完自动清理容器，数据留在 /var/tmp/etcd-restore（可手动 rm）
```

## 四、基础八层的脚本（不在本目录）

第 1~6 章（03~08 册）的脚本在项目工作目录 `k8s-deploy/`，文件名前缀即阶段：

```
s1-*.sh       地基（系统基线 / 内核参数 / containerd）
s2*.py        控制面 HA（haproxy / keepalived / kubeadm init / join / etcd 运维）
s3*.py        网络与入口（Cilium / Gateway API / Envoy Gateway / cert-manager）
s4*.py        存储（数据盘 / Longhorn / 备份目标 / Velero）
s5*.py|yaml   可观测与安全（Prom 栈 / Loki / PSA / Kyverno / RBAC）
s6*.py|yaml   交付（ArgoCD / Gitea / Alloy）
s7~s18        外部依赖与 OIDC / cosign（对应 12 册）
patrol.sh     巡检脚本（已装到 cp-1 /usr/local/bin/k8s-patrol.sh）
```

## 五、回滚顺序（出问题时）

```
改坏了网关/探针       kubectl -n monitoring delete probe <name>；kubectl delete -f s23-probes.yaml
改坏了 CoreDNS        kubectl apply -f /root/coredns-backup.yaml；rollout restart deploy coredns
改坏了 Alertmanager   kubectl -n monitoring patch alertmanager ... -p '{"spec":{"configSecret":null}}'
Sealed Secrets 乱了   私钥备份在 /etc/kubernetes/sealed-secrets-key.backup.yaml（三处一致）
etcd metrics 没生效    备份原本在 /root/etcd.yaml.bak-*，还原后 touch 清单
```
