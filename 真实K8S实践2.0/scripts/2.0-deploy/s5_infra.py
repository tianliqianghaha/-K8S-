"""S5：infra-01 上装集群外依赖 —— SeaweedFS(S3) + Gitea(外部 Git/registry)。"""
import json
import secrets
import sys
from pathlib import Path

import fleet

AK = "k8s-" + secrets.token_hex(6)
SK = secrets.token_urlsafe(24)
WORK = Path(__file__).resolve().parent

S3CFG = json.dumps({
    "identities": [{
        "name": "k8s",
        "credentials": [{"accessKey": AK, "secretKey": SK}],
        "actions": ["Admin", "Read", "Write", "List", "Tagging"],
    }]
}, indent=2)

COMPOSE = f"""services:
  seaweedfs:
    image: chrislusf/seaweedfs:3.80
    container_name: seaweedfs
    restart: always
    command: server -dir=/data -s3 -s3.port=9000 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=1024
    ports:
      - "9333:9333"
      - "8080:8080"
      - "9000:9000"
    volumes:
      - /data/seaweedfs:/data
      - /etc/seaweedfs:/etc/seaweedfs
  gitea:
    image: gitea/gitea:1.24
    container_name: gitea
    restart: always
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - GITEA__database__DB_TYPE=sqlite3
      - GITEA__server__DOMAIN=172.23.163.111
      - GITEA__server__SSH_DOMAIN=172.23.163.111
      - GITEA__server__ROOT_URL=http://172.23.163.111:3000/
      - GITEA__server__DISABLE_REGISTRATION=true
      - GITEA__security__INSTALL_LOCK=true
      - GITEA__service__DISABLE_REGISTRATION=true
    ports:
      - "3000:3000"
      - "2222:22"
    volumes:
      - /data/gitea:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
"""


def main():
    h = fleet.INFRA
    print("[infra] 装 docker ...")
    rc, out = fleet.ssh(h, "DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 update -qq && "
                           "DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -y -qq "
                           "docker.io docker-compose-v2 >/tmp/docker.log 2>&1; echo rc=$?; "
                           "docker --version; docker compose version 2>/dev/null | head -1", timeout=900)
    print(out)

    s3cfg = WORK / "infra-s3.json"
    s3cfg.write_text(S3CFG, encoding="utf-8")
    comp = WORK / "infra-compose.yaml"
    comp.write_text(COMPOSE, encoding="utf-8")

    fleet.ssh(h, "mkdir -p /etc/seaweedfs /data/seaweedfs /data/gitea", timeout=60)
    fleet.scp(s3cfg, "/etc/seaweedfs/s3.json", h)
    fleet.scp(comp, "/root/docker-compose.yaml", h)

    rc, out = fleet.ssh(h, "cd /root && docker compose up -d 2>&1 | tail -6; sleep 8; docker ps --format '{{.Names}} {{.Status}}'", timeout=900)
    print(out)

    rc, out = fleet.ssh(h, r"""
sleep 5
echo "--- gitea ---"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
echo "--- s3 ---"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9000/
echo "--- 建 bucket ---"
for b in longhorn-backup velero-backup loki-chunks tempo-traces; do
  docker exec seaweedfs weed shell -master=localhost:9333 -c "s3.bucket.create -name $b" 2>&1 | tail -1
done
docker exec seaweedfs weed shell -master=localhost:9333 -c "s3.bucket.list" 2>&1 | tail -8
""", timeout=300)
    print(out)

    cred = WORK / "infra-s3-cred.txt"
    cred.write_text(f"endpoint=http://172.23.163.111:9000\naccess_key={AK}\nsecret_key={SK}\n", encoding="utf-8")
    print(f"[infra] S3 凭据写入 {cred.name}（勿外传）")


if __name__ == "__main__":
    main()
