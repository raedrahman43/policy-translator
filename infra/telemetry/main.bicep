targetScope = 'resourceGroup'

@description('Base name used for telemetry resources.')
@minLength(3)
@maxLength(32)
param baseName string = 'policy-translator-telemetry'

@description('Azure region for all telemetry resources.')
param location string = resourceGroup().location

@description('Log Analytics and Application Insights retention in days.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

var suffix = uniqueString(resourceGroup().id, baseName)
var storageName = take('pttelemetry${suffix}', 24)
var functionName = take('${baseName}-${suffix}', 60)
var workspaceName = '${baseName}-logs-${suffix}'
var insightsName = '${baseName}-ai-${suffix}'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: retentionInDays
    sku: {
      name: 'PerGB2018'
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: retentionInDays
    DisableIpMasking: false
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${baseName}-plan-${suffix}'
  location: location
  kind: 'linux'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: insights.properties.ConnectionString
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
      ]
    }
  }
}

var telemetryBaseQuery = '''
let telemetry = traces
| where message startswith "PolicyTranslatorTelemetry "
| extend payload = parse_json(substring(message, strlen("PolicyTranslatorTelemetry ")))
| extend eventName = tostring(payload.eventName),
         sessionId = tostring(payload.sessionId),
         appVersion = tostring(payload.appVersion),
         properties = payload.properties;
'''

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, baseName, 'workbook')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'Policy Translator usage'
    category: 'workbook'
    sourceId: insights.id
    serializedData: string({
      version: 'Notebook/1.0'
      items: [
        {
          type: 1
          content: {
            json: '# Policy Translator telemetry\nAnonymous usage funnel and reliability metrics. No policy contents, tenant identifiers, credentials, feature keys, or Graph payloads are collected.'
          }
          name: 'overview'
        }
        {
          type: 3
          content: {
            version: 'KqlItem/1.0'
            title: '30-day usage summary'
            query: '${telemetryBaseQuery}\ntelemetry\n| where timestamp > ago(30d)\n| summarize Sessions=dcount(sessionId), Starts=countif(eventName == "app_started"), Analyses=countif(eventName == "analysis_completed"), Simulations=countif(eventName == "simulation_completed"), ScriptDownloads=countif(eventName == "scripts_downloaded"), RealApplies=countif(eventName == "real_apply_completed")'
            size: 0
            queryType: 0
            resourceType: 'microsoft.insights/components'
          }
          name: 'summary'
        }
        {
          type: 3
          content: {
            version: 'KqlItem/1.0'
            title: 'Usage funnel by day'
            query: '${telemetryBaseQuery}\ntelemetry\n| where timestamp > ago(30d)\n| summarize Events=count() by bin(timestamp, 1d), eventName\n| render timechart'
            size: 0
            queryType: 0
            resourceType: 'microsoft.insights/components'
          }
          name: 'funnel'
        }
        {
          type: 3
          content: {
            version: 'KqlItem/1.0'
            title: 'Sanitized error categories'
            query: '${telemetryBaseQuery}\ntelemetry\n| where timestamp > ago(30d) and eventName endswith "_failed"\n| extend errorCategory=tostring(properties.errorCategory)\n| summarize Failures=count() by eventName, errorCategory\n| order by Failures desc'
            size: 0
            queryType: 0
            resourceType: 'microsoft.insights/components'
          }
          name: 'errors'
        }
        {
          type: 3
          content: {
            version: 'KqlItem/1.0'
            title: 'Version adoption'
            query: '${telemetryBaseQuery}\ntelemetry\n| where timestamp > ago(30d) and eventName == "app_started"\n| summarize Sessions=dcount(sessionId) by appVersion\n| order by Sessions desc'
            size: 0
            queryType: 0
            resourceType: 'microsoft.insights/components'
          }
          name: 'versions'
        }
      ]
      styleSettings: {}
      '$schema': 'https://github.com/Microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json'
    })
  }
}

output functionAppName string = functionApp.name
output telemetryEndpoint string = 'https://${functionApp.properties.defaultHostName}/api/telemetry'
output applicationInsightsName string = insights.name
output workbookResourceId string = workbook.id
