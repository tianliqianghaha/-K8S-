#!/bin/bash
# 只读采集：输出 KEY=VALUE，由 verify_all.py 解析判分
export KUBECONFIG=/etc/kubernetes/admin.conf
k(){ echo "$1=$(eval "$2" 2>/dev/null | tr -d '\n' | head -c 120)"; }

k nodes_ready        "kubectl get nodes --no-headers | awk '\$2==\"Ready\"' | wc -l"
k nodes_total        "kubectl get nodes --no-headers | wc -l"
k pods_running       "kubectl get pods -A --no-headers | awk '\$4==\"Running\"' | wc -l"
k pods_bad           "kubectl get pods -A --no-headers | awk '\$4!=\"Running\" && \$4!=\"Completed\"' | wc -l"
k ns_count           "kubectl get ns --no-headers | wc -l"
k pvc_total          "kubectl get pvc -A --no-headers | wc -l"
k pvc_bound          "kubectl get pvc -A --no-headers | awk '\$3==\"Bound\"' | wc -l"
k kube_proxy_ds      "kubectl -n kube-system get ds kube-proxy --no-headers 2>/dev/null | wc -l"
k kubesvc_chains     "iptables-save | grep -c 'KUBE-SVC\\|KUBE-SERVICES\\|KUBE-NODEPORTS'"
k etcd_members       "kubectl -n kube-system exec etcd-cp-1 -- etcdctl member list --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key 2>/dev/null | grep -c started"
k cilium_ready       "kubectl -n kube-system get ds cilium -o jsonpath='{.status.numberReady}'"
k prom_ready         "kubectl -n monitoring get sts prometheus-kps-kube-prometheus-stack-prometheus -o jsonpath='{.status.readyReplicas}'"
k am_ready           "kubectl -n monitoring get sts alertmanager-kps-kube-prometheus-stack-alertmanager -o jsonpath='{.status.readyReplicas}'"
k grafana_ready      "kubectl -n monitoring get deploy kps-grafana -o jsonpath='{.status.readyReplicas}'"
k alloy_ready        "kubectl -n monitoring get ds alloy -o jsonpath='{.status.numberReady}'"
k beyla_ready        "kubectl -n monitoring get ds beyla -o jsonpath='{.status.numberReady}'"
k tempo_ready        "kubectl -n monitoring get sts tempo -o jsonpath='{.status.readyReplicas}'"
k otelcol_ready      "kubectl -n monitoring get deploy otelcol-opentelemetry-collector -o jsonpath='{.status.readyReplicas}'"
k longhorn_target    "kubectl -n longhorn-system get backuptarget default -o jsonpath='{.status.available}'"
k longhorn_healthy   "kubectl -n longhorn-system get volumes.longhorn.io --no-headers 2>/dev/null | grep -c healthy"
k velero_bsl         "kubectl -n velero get backupstoragelocation default -o jsonpath='{.status.phase}'"
k velero_backups     "kubectl -n velero get backups.velero.io -o jsonpath='{range .items[*]}{.status.phase}{\"\\n\"}{end}' 2>/dev/null | grep -c Completed"
k kyverno_policies   "kubectl get validatingpolicies.policies.kyverno.io --no-headers 2>/dev/null | wc -l"
k map_policies       "kubectl get mutatingadmissionpolicies --no-headers 2>/dev/null | wc -l"
k vpa_objects        "kubectl get vpa -A --no-headers 2>/dev/null | wc -l"
k keda_so            "kubectl get scaledobject -A --no-headers 2>/dev/null | wc -l"
k kueue_wl           "kubectl get workloads.kueue.x-k8s.io -A --no-headers 2>/dev/null | wc -l"
k argo_healthy       "kubectl -n argocd get applications --no-headers 2>/dev/null | awk '\$3==\"Healthy\"' | wc -l"
k rollout_phase      "kubectl -n demo-app get rollout canary -o jsonpath='{.status.phase}'"
k zone_b             "kubectl get nodes -L topology.kubernetes.io/zone --no-headers | grep -c cn-hongkong-b"
k zone_d             "kubectl get nodes -L topology.kubernetes.io/zone --no-headers | grep -c cn-hongkong-d"
k zone_c             "kubectl get nodes -L topology.kubernetes.io/zone --no-headers | grep -c cn-hongkong-c"
k helm_not_deployed  "helm list -A --no-headers | awk '\$8!=\"deployed\"' | wc -l"

k encryption         "kubectl -n kube-system exec ds/cilium -- cilium-dbg status 2>/dev/null | grep -i '^Encryption:' | cut -d: -f2 | tr -d ' ' | cut -d'[' -f1"
k sealed_secret      "kubectl -n demo-secrets get secret db-cred --no-headers 2>/dev/null | wc -l"
k oidc_flags         "ps -eo args 2>/dev/null | grep -c 'oidc-issuer-url'"
k argo_apps          "kubectl -n argocd get applications --no-headers 2>/dev/null | wc -l"
k gateway_prog       "kubectl -n demo-app get gateway eg -o jsonpath='{.status.conditions[?(@.type==\"Programmed\")].status}'"
k gatewayclass_n     "kubectl get gatewayclass --no-headers 2>/dev/null | wc -l"
k httproute_n        "kubectl get httproute -A --no-headers 2>/dev/null | wc -l"
k cert_ready         "kubectl -n cert-manager get certificate apps-wildcard -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}'"

k deviceclass_n      "kubectl get deviceclass --no-headers 2>/dev/null | wc -l"
k dra_slices         "kubectl get resourceslices.resource.k8s.io -A --no-headers 2>/dev/null | wc -l"
k dra_claim_ok       "kubectl -n demo-app get resourceclaims.resource.k8s.io --no-headers 2>/dev/null | grep -c allocated"

EGSVC=$(kubectl -n envoy-gateway-system get svc -o name 2>/dev/null | grep envoy-demo-app-eg | head -1 | cut -d/ -f2)
HNP=$(kubectl -n envoy-gateway-system get svc "$EGSVC" -o jsonpath='{.spec.ports[?(@.name=="https-443")].nodePort}' 2>/dev/null)
PNP=$(kubectl -n envoy-gateway-system get svc "$EGSVC" -o jsonpath='{.spec.ports[?(@.name=="http-80")].nodePort}' 2>/dev/null)
NODE=172.23.163.110
k ing_https_ok   "curl -sk --resolve demo.apps.k8s.local:\$HNP:\$NODE -o /dev/null -w '%{http_code}' https://demo.apps.k8s.local:\$HNP/"
k ing_host_bad   "curl -sk --resolve wrong.apps.k8s.local:\$HNP:\$NODE -o /dev/null -w '%{http_code}' https://wrong.apps.k8s.local:\$HNP/"
k ing_redirect   "curl -s -o /dev/null -w '%{http_code}' http://\$NODE:\$PNP/ -H 'Host: demo.apps.k8s.local'"
