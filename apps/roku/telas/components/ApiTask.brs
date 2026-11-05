sub init()
  m.top.functionName = "executar"
end sub

' HTTP só roda aqui (Task), nunca no render thread. A sessão vem do Registry do próprio app.
sub executar()
  pedido = m.top.request
  if pedido = invalid then return
  credencial = lerSessao()
  m.top.response = apiRequest(pedido.method, pedido.path, pedido.body, credencial)
end sub

' roUrlTransfer não tem GetResponseCode(): usar Async* + roUrlEvent (status <= 0 = falha do curl).
function apiRequest(method as String, path as String, body as String, credencial as String) as Object
  port = CreateObject("roMessagePort")
  transfer = CreateObject("roUrlTransfer")
  transfer.SetMessagePort(port)
  transfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  transfer.InitClientCertificates()
  transfer.RetainBodyOnError(true)
  transfer.SetUrl(openCebolaApiUrl() + path)
  transfer.AddHeader("Accept", "application/json")
  if credencial <> "" then transfer.AddHeader("Authorization", "Bearer " + credencial)

  if method = "POST" then
    ' Sem Content-Type a Roku manda formulário e a API responde 415.
    transfer.AddHeader("Content-Type", "application/json")
    if body = "" then body = "{}"
    started = transfer.AsyncPostFromString(body)
  else
    started = transfer.AsyncGetToString()
  end if
  if not started then return { "status": 0, "body": "" }

  event = wait(15000, port)
  if type(event) = "roUrlEvent" then
    return { "status": event.GetResponseCode(), "body": event.GetString() }
  end if
  transfer.AsyncCancel()
  return { "status": 0, "body": "" }
end function

function lerSessao() as String
  section = CreateObject("roRegistrySection", "cebola")
  if section.Exists("session") then return section.Read("session")
  return ""
end function
