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
