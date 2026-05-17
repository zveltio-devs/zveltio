{{/*
Expand the name of the chart.
*/}}
{{- define "zveltio.name" -}}
{{- default .Chart.Name .Values.engine.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited
to this (by the DNS naming spec).
*/}}
{{- define "zveltio.fullname" -}}
{{- if .Values.engine.fullnameOverride }}
{{- .Values.engine.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.engine.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "zveltio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "zveltio.labels" -}}
helm.sh/chart: {{ include "zveltio.chart" . }}
{{ include "zveltio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "zveltio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "zveltio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "zveltio.serviceAccountName" -}}
{{- if .Values.engine.serviceAccount.create }}
{{- default (include "zveltio.fullname" .) .Values.engine.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.engine.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolve the engine image. Falls back to .Chart.AppVersion when tag is empty.
*/}}
{{- define "zveltio.image" -}}
{{- $repo := .Values.engine.image.repository -}}
{{- $tag  := default .Chart.AppVersion .Values.engine.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end }}

{{/*
Database URL — prefer the in-cluster postgresql release when enabled,
otherwise use the explicit engine.config.databaseUrl.
*/}}
{{- define "zveltio.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "postgres://%s:%s@%s-postgres:5432/%s"
    .Values.postgresql.auth.username
    .Values.postgresql.auth.password
    (include "zveltio.fullname" .)
    .Values.postgresql.auth.database -}}
{{- else -}}
{{- .Values.engine.config.databaseUrl -}}
{{- end -}}
{{- end }}

{{/*
Valkey URL — prefer the in-cluster redis release when enabled.
*/}}
{{- define "zveltio.valkeyUrl" -}}
{{- if .Values.redis.enabled -}}
{{- if and .Values.redis.auth.enabled .Values.redis.auth.password -}}
{{- printf "redis://:%s@%s-valkey:6379" .Values.redis.auth.password (include "zveltio.fullname" .) -}}
{{- else -}}
{{- printf "redis://%s-valkey:6379" (include "zveltio.fullname" .) -}}
{{- end -}}
{{- else -}}
{{- .Values.engine.config.valkeyUrl -}}
{{- end -}}
{{- end }}

{{/*
Secret name — either the user-provided existing secret or the chart-managed one.
*/}}
{{- define "zveltio.secretName" -}}
{{- if .Values.engine.existingSecret -}}
{{- .Values.engine.existingSecret -}}
{{- else -}}
{{- include "zveltio.fullname" . }}-env
{{- end -}}
{{- end }}
