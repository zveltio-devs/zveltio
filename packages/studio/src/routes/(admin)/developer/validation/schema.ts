/**
 * Developer → Validation Rules, as the declarative page `SchemaPage` renders.
 * The engine's `/api/validation` (tenant admins); the rules bind every write.
 */
import type { PageSchema } from '#lib/sdui/types.js';

export const schema = {
  sduiSchema: 1,
  title: 'developer.validation.title',
  subtitle: 'developer.validation.subtitle',
  newLabel: 'developer.validation.newRule',
  resources: [
    {
      id: 'rules',
      dataSource: '/api/validation/rules',
      dataPath: 'data',
      search: {
        fields: ['collection', 'field_name', 'error_message', 'rule_type'],
        placeholder: 'common.search',
      },
      columns: [
        {
          key: 'collection',
          label: 'common.col.collection',
          type: 'badge',
          badge: {
            colors: {},
          },
        },
        {
          key: 'field_name',
          label: 'common.col.field',
          type: 'mono',
        },
        {
          key: 'scope',
          label: 'developer.validation.col.scope',
          type: 'badge',
          badge: {
            colors: {
              instance: 'badge-info',
              tenant: 'badge-ghost',
            },
            labels: {
              instance: 'developer.validation.scope.instance',
              tenant: 'developer.validation.scope.tenant',
            },
          },
        },
        {
          key: 'rule_type',
          label: 'developer.validation.col.ruleType',
        },
        {
          key: 'error_message',
          label: 'common.col.description',
        },
        {
          key: 'is_active',
          label: 'common.col.active',
          type: 'boolean',
          editable: {
            endpoint: '/api/validation/rules/{id}',
            field: 'is_active',
            options: [
              {
                value: 'true',
                label: 'developer.validation.on',
              },
              {
                value: 'false',
                label: 'developer.validation.off',
              },
            ],
          },
        },
      ],
      rowActions: [
        {
          id: 'delete',
          icon: 'Trash2',
          variant: 'text-error',
          label: 'common.delete',
          method: 'DELETE',
          endpoint: '/api/validation/rules/{id}',
          confirm: 'developer.validation.confirmDelete',
        },
      ],
      form: {
        endpoint: '/api/validation/rules',
        fields: [
          {
            name: 'collection',
            label: 'common.col.collection',
            type: 'relation',
            required: true,
            colSpan: 1,
            relation: {
              dataSource: '/api/collections',
              dataPath: 'collections',
              valueKey: 'name',
              labelKey: 'name',
            },
          },
          {
            name: 'field_name',
            label: 'common.col.field',
            required: true,
            mono: true,
            colSpan: 1,
          },
          {
            name: 'rule_type',
            label: 'developer.validation.ruleType',
            type: 'select',
            required: true,
            colSpan: 1,
            default: 'required',
            options: [
              {
                value: 'required',
                label: 'developer.validation.rule.required',
              },
              {
                value: 'min',
                label: 'developer.validation.rule.min',
              },
              {
                value: 'max',
                label: 'developer.validation.rule.max',
              },
              {
                value: 'minLength',
                label: 'developer.validation.rule.minLength',
              },
              {
                value: 'maxLength',
                label: 'developer.validation.rule.maxLength',
              },
              {
                value: 'pattern',
                label: 'developer.validation.rule.pattern',
              },
              {
                value: 'range',
                label: 'developer.validation.rule.range',
              },
              {
                value: 'email',
                label: 'developer.validation.rule.email',
              },
              {
                value: 'url',
                label: 'developer.validation.rule.url',
              },
              {
                value: 'nlp',
                label: 'developer.validation.rule.nlp',
              },
              {
                value: 'transition',
                label: 'developer.validation.rule.transition',
              },
            ],
          },
          {
            name: 'error_message',
            label: 'developer.validation.form.description',
            required: true,
            colSpan: 2,
          },
          {
            name: 'rule_config',
            label: 'developer.validation.configJson',
            type: 'json',
            mono: true,
            rows: 5,
            colSpan: 2,
            default: {},
          },
          {
            name: 'nl_description',
            label: 'developer.validation.form.nlDescription',
            colSpan: 2,
          },
        ],
      },
    },
  ],
} as unknown as PageSchema;
