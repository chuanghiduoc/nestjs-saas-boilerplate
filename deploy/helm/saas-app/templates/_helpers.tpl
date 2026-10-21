{{/*
Helper của chart saas-app (spec SP7 §6.4, §12). Mọi bất biến của values mà schema không diễn đạt được nằm ở
templates/checks.yaml; helper ở đây chỉ dựng giá trị và `fail` khi một giá trị không dựng được.
*/}}

{{/* Giới hạn độ dài tên đối tượng Kubernetes (DNS label, RFC 1123). */}}
{{- define "saas-app.maxNameLength" -}}63{{- end -}}

{{- define "saas-app.fullname" -}}
{{- printf "%s-saas-app" .Release.Name -}}
{{- end -}}

{{/* Tên đối tượng: dict { root, suffix }. Quá 63 ký tự thì fail (không cắt: cắt có thể làm hai đối tượng trùng tên). */}}
{{- define "saas-app.name" -}}
{{- $n := printf "%s-%s" (include "saas-app.fullname" .root) .suffix -}}
{{- if gt (len $n) (int (include "saas-app.maxNameLength" .)) -}}
{{- fail (printf "object name %q is longer than %s characters; use a shorter release name or worker group name" $n (include "saas-app.maxNameLength" .)) -}}
{{- end -}}
{{- $n -}}
{{- end -}}

{{/* Nhãn chọn pod: bất biến giữa các lần upgrade (selector của Deployment không đổi được). dict { root, component }. */}}
{{- define "saas-app.selectorLabels" -}}
app.kubernetes.io/name: saas-app
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Nhãn chuẩn; version = appVersion của chart (không phụ thuộc image). dict { root, component }. */}}
{{- define "saas-app.labels" -}}
{{ include "saas-app.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/part-of: saas-app
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{/* Image: digest thắng tag (policy Kyverno xác minh digest, spec §12.8). */}}
{{- define "saas-app.image" -}}
{{- $i := .Values.image -}}
{{- if $i.digest -}}
{{- printf "%s@%s" $i.repository $i.digest -}}
{{- else if $i.tag -}}
{{- printf "%s:%s" $i.repository $i.tag -}}
{{- else -}}
{{- fail "image: set image.digest (production) or image.tag" -}}
{{- end -}}
{{- end -}}

{{- define "saas-app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "saas-app.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{/* Allowlist secret theo vai trò, SINH bởi `pnpm chart:secrets` từ `.meta(secretMeta(...))`. */}}
{{- define "saas-app.secretAllowlist" -}}
{{- .Files.Get "files/secret-env.json" -}}
{{- end -}}

{{/* Env hiệu lực của một vai trò: `config` đè bởi `api.env` / `workers.<g>.env`. dict { root, env } → JSON. */}}
{{- define "saas-app.effectiveEnv" -}}
{{- toJson (mergeOverwrite (deepCopy .root.Values.config) (deepCopy (.env | default dict))) -}}
{{- end -}}

{{/* Đường mount CA của chart (nội bộ chart; DB_SSL_CA_PATH và NODE_EXTRA_CA_CERTS là khoá do chart đặt). */}}
{{- define "saas-app.dbCaDir" -}}/etc/saas-app/db-ca{{- end -}}
{{- define "saas-app.extraCaDir" -}}/etc/saas-app/extra-ca{{- end -}}
{{- define "saas-app.caFileName" -}}ca.crt{{- end -}}

{{- define "saas-app.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .Values.podSecurity.runAsUser }}
runAsGroup: {{ .Values.podSecurity.runAsGroup }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "saas-app.containerSecurityContext" -}}
readOnlyRootFilesystem: true
allowPrivilegeEscalation: false
privileged: false
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Volume và mount chung: /tmp (emptyDir, rootfs chỉ đọc) và CA tuỳ chọn. dict { root, withExtraCa } */}}
{{- define "saas-app.volumes" -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ .root.Values.tmp.sizeLimit }}
{{- with .root.Values.dbCa.configMapName }}
- name: db-ca
  configMap:
    name: {{ . }}
    items:
      - key: {{ $.root.Values.dbCa.key }}
        path: {{ include "saas-app.caFileName" $ }}
{{- end }}
{{- if and .withExtraCa .root.Values.extraCaCerts.configMapName }}
- name: extra-ca
  configMap:
    name: {{ .root.Values.extraCaCerts.configMapName }}
    items:
      - key: {{ .root.Values.extraCaCerts.key }}
        path: {{ include "saas-app.caFileName" . }}
{{- end }}
{{- end -}}

{{- define "saas-app.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
{{- if .root.Values.dbCa.configMapName }}
- name: db-ca
  mountPath: {{ include "saas-app.dbCaDir" . }}
  readOnly: true
{{- end }}
{{- if and .withExtraCa .root.Values.extraCaCerts.configMapName }}
- name: extra-ca
  mountPath: {{ include "saas-app.extraCaDir" . }}
  readOnly: true
{{- end }}
{{- end -}}

{{- define "saas-app.caEnv" -}}
{{- if .root.Values.dbCa.configMapName }}
- name: DB_SSL_CA_PATH
  value: {{ printf "%s/%s" (include "saas-app.dbCaDir" .) (include "saas-app.caFileName" .) | quote }}
{{- end }}
{{- if and .withExtraCa .root.Values.extraCaCerts.configMapName }}
- name: NODE_EXTRA_CA_CERTS
  value: {{ printf "%s/%s" (include "saas-app.extraCaDir" .) (include "saas-app.caFileName" .) | quote }}
{{- end }}
{{- end -}}

{{/* OTel (spec §12.2): downward API trước, rồi biến dùng $(VAR). dict { root, role, group } */}}
{{- define "saas-app.otelEnv" -}}
{{- $o := .root.Values.otel -}}
{{- if $o.enabled }}
- name: POD_NAME
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: POD_NAMESPACE
  valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
- name: POD_UID
  valueFrom: { fieldRef: { fieldPath: metadata.uid } }
- name: HOST_IP
  valueFrom: { fieldRef: { fieldPath: status.hostIP } }
- name: OTEL_ENABLED
  value: "true"
- name: OTEL_SERVICE_NAME
  value: {{ printf "%s-%s" ($o.serviceNamePrefix | default (include "saas-app.fullname" .root)) .role | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
{{- if $o.endpointFromHostIP.enabled }}
  value: {{ printf "%s://$(HOST_IP):%v" $o.endpointFromHostIP.scheme $o.endpointFromHostIP.port | quote }}
{{- else }}
  value: {{ $o.endpoint | quote }}
{{- end }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ printf "k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),k8s.pod.uid=$(POD_UID),deployment.environment.name=%s,app.role=%s%s" .root.Values.environment .role (ternary (printf ",app.worker.group=%s" .group) "" (ne .group "")) | quote }}
{{- end }}
{{- end -}}

{{/* Env của nhóm (api.env / workers.<g>.env): đè ConfigMap chung vì env đứng sau envFrom. */}}
{{- define "saas-app.groupEnv" -}}
{{- range $k, $v := . }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{/* Ba probe theo port của vai trò; timeoutSeconds 1 > HEALTH_CHECK_TIMEOUT_MS 500 (probe nhận 503 sạch). dict { probes, port } */}}
{{- define "saas-app.probes" -}}
startupProbe:
  httpGet: { path: /health/live, port: {{ .port }} }
  {{- toYaml .probes.startup | nindent 2 }}
livenessProbe:
  httpGet: { path: /health/live, port: {{ .port }} }
  {{- toYaml .probes.liveness | nindent 2 }}
readinessProbe:
  httpGet: { path: /health/ready, port: {{ .port }} }
  {{- toYaml .probes.readiness | nindent 2 }}
{{- end -}}

{{/*
Một Deployment (api hoặc một nhóm worker). dict { root, component, role, group, w, probes, probePort, args, ports, roleEnv }.
Thứ tự env: APP_ROLE, env của vai trò, CA, OTel, env của nhóm, secret. envFrom ConfigMap chung đứng trước nên
mọi `env` đè được nó.
*/}}
{{- define "saas-app.deployment" -}}
{{- $root := .root -}}
{{- $sel := dict "root" $root "component" .component -}}
{{- $name := include "saas-app.name" (dict "root" $root "suffix" .component) -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "saas-app.labels" $sel | nindent 4 }}
spec:
  {{- if not .w.hpa.enabled }}
  replicas: {{ .w.replicas }}
  {{- end }}
  revisionHistoryLimit: {{ $root.Values.rollout.revisionHistoryLimit }}
  progressDeadlineSeconds: {{ $root.Values.rollout.progressDeadlineSeconds }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: {{ $root.Values.rollout.maxSurge }}
      maxUnavailable: 0
  selector:
    matchLabels:
      {{- include "saas-app.selectorLabels" $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "saas-app.labels" $sel | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
    spec:
      serviceAccountName: {{ include "saas-app.serviceAccountName" $root }}
      automountServiceAccountToken: false
      enableServiceLinks: false
      terminationGracePeriodSeconds: {{ $root.Values.terminationGracePeriodSeconds }}
      securityContext:
        {{- include "saas-app.podSecurityContext" $root | nindent 8 }}
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: {{ $root.Values.topologySpread.hostname }}
          labelSelector:
            matchLabels:
              {{- include "saas-app.selectorLabels" $sel | nindent 14 }}
          matchLabelKeys: [pod-template-hash]
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: {{ $root.Values.topologySpread.zone }}
          labelSelector:
            matchLabels:
              {{- include "saas-app.selectorLabels" $sel | nindent 14 }}
          matchLabelKeys: [pod-template-hash]
      containers:
        - name: {{ .role }}
          image: {{ include "saas-app.image" $root }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          args:
            {{- toYaml .args | nindent 12 }}
          ports:
            {{- toYaml .ports | nindent 12 }}
          envFrom:
            - configMapRef:
                name: {{ include "saas-app.name" (dict "root" $root "suffix" "config") }}
          env:
            - name: APP_ROLE
              value: {{ .role | quote }}
            {{- toYaml .roleEnv | nindent 12 }}
            {{- with include "saas-app.caEnv" (dict "root" $root "withExtraCa" true) | trim }}{{ . | nindent 12 }}{{ end }}
            {{- with include "saas-app.otelEnv" (dict "root" $root "role" .role "group" .group) | trim }}{{ . | nindent 12 }}{{ end }}
            {{- with include "saas-app.groupEnv" .w.env | trim }}{{ . | nindent 12 }}{{ end }}
            {{- with include "saas-app.secretEnv" (dict "root" $root "role" .role) | trim }}{{ . | nindent 12 }}{{ end }}
          {{- include "saas-app.probes" (dict "probes" .probes "port" .probePort) | nindent 10 }}
          resources:
            {{- toYaml .w.resources | nindent 12 }}
          securityContext:
            {{- include "saas-app.containerSecurityContext" $root | nindent 12 }}
          volumeMounts:
            {{- include "saas-app.volumeMounts" (dict "root" $root "withExtraCa" true) | nindent 12 }}
      volumes:
        {{- include "saas-app.volumes" (dict "root" $root "withExtraCa" true) | nindent 8 }}
{{- end -}}

{{/* HPA autoscaling/v2 (CPU + extraMetrics). dict { root, component, w } */}}
{{- define "saas-app.hpa" -}}
{{- $name := include "saas-app.name" (dict "root" .root "suffix" .component) -}}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ $name }}
  labels:
    {{- include "saas-app.labels" (dict "root" .root "component" .component) | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ $name }}
  minReplicas: {{ .w.hpa.minReplicas }}
  maxReplicas: {{ .w.hpa.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .w.hpa.targetCPUUtilizationPercentage }}
    {{- with .w.hpa.extraMetrics }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  behavior:
    scaleDown:
      stabilizationWindowSeconds: {{ .w.hpa.scaleDownStabilizationSeconds }}
{{- end -}}

{{/* PDB policy/v1; luôn render (1 replica vẫn cho evict, không chặn drain node). dict { root, component, w } */}}
{{- define "saas-app.pdb" -}}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "saas-app.name" (dict "root" .root "suffix" .component) }}
  labels:
    {{- include "saas-app.labels" (dict "root" .root "component" .component) | nindent 4 }}
spec:
  maxUnavailable: {{ .w.pdb.maxUnavailable }}
  # Pod không Ready (CrashLoopBackOff) không được chặn drain node (policy/v1, GA từ Kubernetes 1.31).
  unhealthyPodEvictionPolicy: AlwaysAllow
  selector:
    matchLabels:
      {{- include "saas-app.selectorLabels" (dict "root" .root "component" .component) | nindent 6 }}
{{- end -}}

{{/*
Env secret của một vai trò: mỗi khoá là một secretKeyRef tới Secret có sẵn; chart không bao giờ sinh Secret.
`secretEnv.<ENV>.roles` bỏ trống = vai trò của allowlist sinh từ code. Kiểm hợp lệ ở checks.yaml. dict { root, role }.
*/}}
{{- define "saas-app.secretEnv" -}}
{{- $root := .root -}}
{{- $role := .role -}}
{{- $allow := include "saas-app.secretAllowlist" $root | fromJson -}}
{{- range $name, $s := $root.Values.secretEnv }}
{{- if not (hasKey $allow $name) }}
{{- fail (printf "secretEnv.%s is not a boilerplate secret (files/secret-env.json is generated from the config schemas); declare project secrets under secretEnvExtra" $name) }}
{{- end }}
{{- if has $role ($s.roles | default (get $allow $name)) }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $s.secretName }}
      key: {{ $s.key }}
{{- end }}
{{- end }}
{{- range $name, $s := $root.Values.secretEnvExtra }}
{{- if has $role $s.roles }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $s.secretName }}
      key: {{ $s.key }}
{{- end }}
{{- end }}
{{- end -}}

{{/* G = ceil(DB_MIGRATION_STATEMENT_TIMEOUT_MS / 1000) (spec §12.4). Không đặt, hoặc không phải số nguyên dương → fail (Sprig atoi biến chuỗi lạ thành 0). */}}
{{- define "saas-app.migrateGraceSeconds" -}}
{{- $raw := toString (get .Values.config "DB_MIGRATION_STATEMENT_TIMEOUT_MS" | default "") -}}
{{- if not $raw -}}
{{- fail "migrate.enabled needs config.DB_MIGRATION_STATEMENT_TIMEOUT_MS set explicitly (the Job grace period and the Helm timeout are computed from it; the chart does not copy the app default)" -}}
{{- end -}}
{{- if not (regexMatch "^[1-9][0-9]*$" $raw) -}}
{{- fail (printf "config.DB_MIGRATION_STATEMENT_TIMEOUT_MS must be a positive integer of milliseconds, got %q" $raw) -}}
{{- end -}}
{{- div (add (atoi $raw) 999) 1000 -}}
{{- end -}}

{{/*
Hậu tố revision rộng nhất mà kiểm độ dài tên Job dự trữ. Revision > 999999 làm tên dài thêm một ký tự: khi đó
saas-app.name trong migrate-job.yaml (với revision thật) vẫn fail có tên.
*/}}
{{- define "saas-app.migrateRevisionReserve" -}}-r999999{{- end -}}

{{/* T_min = activeDeadlineSeconds + G + timeoutMarginSeconds: --timeout tối thiểu của helm upgrade (spec §12.4). */}}
{{- define "saas-app.helmTimeoutMinSeconds" -}}
{{- add (int .Values.migrate.activeDeadlineSeconds) (int (include "saas-app.migrateGraceSeconds" .)) (int .Values.migrate.timeoutMarginSeconds) -}}
{{- end -}}

{{/*
Cổng internet của NetworkPolicy = RESILIENCE_ALLOWED_PORTS của vai trò (một nguồn với guard SSRF của app,
`resilience.config.ts`: tách theo ",", trim, bỏ phần rỗng, số nguyên 1–65535, ít nhất một). dict { env, who } → JSON.
*/}}
{{- define "saas-app.allowedPorts" -}}
{{- $raw := get .env "RESILIENCE_ALLOWED_PORTS" | default "" -}}
{{- if not $raw -}}
{{- fail (printf "%s: networkPolicy.egress.internet.enabled needs RESILIENCE_ALLOWED_PORTS set explicitly in config (or the role env); the chart does not copy the app default" .who) -}}
{{- end -}}
{{- $out := list -}}
{{- range $p := splitList "," $raw -}}
{{- $t := trim $p -}}
{{- if $t -}}
{{- if not (regexMatch "^[0-9]+$" $t) -}}
{{- fail (printf "%s: RESILIENCE_ALLOWED_PORTS has %q, which is not a port number" $.who $t) -}}
{{- end -}}
{{- $n := atoi $t -}}
{{- if or (lt $n 1) (gt $n 65535) -}}
{{- fail (printf "%s: RESILIENCE_ALLOWED_PORTS has %q, outside 1-65535" $.who $t) -}}
{{- end -}}
{{- $out = append $out $n -}}
{{- end -}}
{{- end -}}
{{- if not $out -}}
{{- fail (printf "%s: RESILIENCE_ALLOWED_PORTS has no port" .who) -}}
{{- end -}}
{{- toJson (uniq $out) -}}
{{- end -}}

{{/*
Dải không phải internet công cộng: this-network, RFC 1918, CGNAT, loopback, link-local (gồm metadata
169.254.169.254 và NodeLocal DNS 169.254.20.10), IETF protocol assignments, benchmarking, multicast, reserved; v6: loopback,
NAT64 (64:ff9b::/96 trỏ ngược vào IPv4 riêng), ULA, link-local.
*/}}
{{- define "saas-app.privateRangesV4" -}}
["0.0.0.0/8","10.0.0.0/8","100.64.0.0/10","127.0.0.0/8","169.254.0.0/16","172.16.0.0/12","192.0.0.0/24","192.168.0.0/16","198.18.0.0/15","224.0.0.0/4","240.0.0.0/4"]
{{- end -}}
{{- define "saas-app.privateRangesV6" -}}
["::1/128","64:ff9b::/96","fc00::/7","fe80::/10"]
{{- end -}}

{{/* Đích internet: 0.0.0.0/0 và ::/0 trừ dải riêng + networkPolicy.egress.internet.exceptExtra (theo họ địa chỉ). dict { root, ports } → JSON rule. */}}
{{- define "saas-app.internetTo" -}}
{{- $v4 := include "saas-app.privateRangesV4" . | fromJsonArray -}}
{{- $v6 := include "saas-app.privateRangesV6" . | fromJsonArray -}}
{{- range $c := .root.Values.networkPolicy.egress.internet.exceptExtra -}}
{{- if contains ":" $c -}}{{- $v6 = append $v6 $c -}}{{- else -}}{{- $v4 = append $v4 $c -}}{{- end -}}
{{- end -}}
{{- $ports := list -}}
{{- range $p := .ports -}}{{- $ports = append $ports (dict "protocol" "TCP" "port" (int $p)) -}}{{- end -}}
{{- toJson (dict
  "to" (list
    (dict "ipBlock" (dict "cidr" "0.0.0.0/0" "except" $v4))
    (dict "ipBlock" (dict "cidr" "::/0" "except" $v6)))
  "ports" $ports) -}}
{{- end -}}

{{/* Rule egress internet của vai trò: cổng = RESILIENCE_ALLOWED_PORTS của vai trò. dict { root, env, who } → JSON. */}}
{{- define "saas-app.internetRule" -}}
{{- include "saas-app.internetTo" (dict "root" .root "ports" (include "saas-app.allowedPorts" . | fromJsonArray)) -}}
{{- end -}}
