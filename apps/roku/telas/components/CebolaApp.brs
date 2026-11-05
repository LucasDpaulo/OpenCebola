' Tela de perfis ("Quem está assistindo?") e placeholder do Início (a T2 troca o Início).
' Foco manual: este nó recebe as teclas e desenha o realce no cartão escolhido.

' Versão mínima da casca que esta biblioteca aceita; subir quando a biblioteca exigir algo novo da casca.
function CASCA_MINIMA() as String
  return "0.1.0"
end function

sub init()
  m.api = m.top.findNode("api")
  m.api.observeField("response", "onResposta")
  m.perfis = []
  m.cartoes = []
  m.indice = 0
  m.fase = "carregando" ' carregando | perfis | ativando | inicio
  m.pendente = invalid
  m.top.setFocus(true)
  m.tarefaPareamento = m.top.findNode("pairingTask")
  m.tarefaPareamento.observeField("pairingCode", "onCodigoPareamento")
  m.tarefaPareamento.observeField("result", "onResultadoPareamento")
  m.autoRetry = m.top.findNode("autoRetry")
  m.autoRetry.observeField("fire", "onNovoPareamento")
  m.top.findNode("pRetry").observeField("buttonSelected", "onNovoPareamento")
end sub

' A casca preenche cascaVersion logo após criar o nó; só então as telas começam.
sub verificarCasca()
  if m.iniciou = true then return
  m.iniciou = true
  if versaoMenor(m.top.cascaVersion, CASCA_MINIMA()) then
    m.fase = "bloqueado"
    m.top.pronto = true
    for each id in ["titulo", "mensagem", "perfis"]
      m.top.findNode(id).visible = false
    end for
    m.top.findNode("desatualizada").visible = true
    return
  end if
  iniciar()
end sub

' Primeira tela: o PairingTask confere a sessão salva (200 = segue para perfis; 401 apaga o token
' e pede código novo; rede/servidor fora não desconectam a TV).
sub iniciar()
  m.fase = "pareando"
  m.top.findNode("titulo").visible = false
  m.top.findNode("mensagem").visible = false
  m.top.findNode("perfis").visible = false
  m.top.findNode("pareamento").visible = true
  m.top.findNode("pRetry").visible = false
  m.top.findNode("pCodigo").text = "------"
  m.top.findNode("pStatus").text = "Verificando a conexão…"
  m.tarefaPareamento.control = "STOP"
  m.tarefaPareamento.control = "RUN"
  m.top.pronto = true
end sub

sub onCodigoPareamento()
  if m.tarefaPareamento.pairingCode <> "" then
    m.top.findNode("pCodigo").text = m.tarefaPareamento.pairingCode
    m.top.findNode("pStatus").text = "Aguardando aprovação pelo site…"
  end if
end sub

sub onResultadoPareamento()
  resultado = m.tarefaPareamento.result
  if resultado = "paired" then
    m.top.findNode("pareamento").visible = false
    m.top.findNode("titulo").visible = true
    m.top.findNode("mensagem").visible = true
    m.top.findNode("perfis").visible = true
    m.fase = "carregando"
    pedir("GET", "/v1/profiles", "")
  else if resultado = "expired" then
    m.top.findNode("pStatus").text = "O código expirou. Gere outro código."
    m.top.findNode("pRetry").visible = true
    m.top.findNode("pRetry").setFocus(true)
    m.autoRetry.control = "start"
  else if resultado = "error" then
    m.top.findNode("pStatus").text = "Não foi possível conectar. Confira a internet. Tentando de novo em instantes."
    m.top.findNode("pRetry").visible = true
    m.top.findNode("pRetry").setFocus(true)
    m.autoRetry.control = "start"
  end if
end sub

sub onNovoPareamento()
  m.autoRetry.control = "stop"
  m.top.setFocus(true)
  iniciar()
end sub

' Compara "maior.menor.build" numericamente; versão vazia/ilegível conta como antiga.
function versaoMenor(a as String, b as String) as Boolean
  pa = a.Split(".")
  pb = b.Split(".")
  if a = "" then return true
  for i = 0 to 2
    va = 0
    vb = 0
    if i < pa.count() then va = Val(pa[i])
    if i < pb.count() then vb = Val(pb[i])
    if va < vb then return true
    if va > vb then return false
  end for
  return false
end function

sub pedir(metodo as String, caminho as String, corpo as String)
  m.api.control = "STOP"
  m.api.request = { "method": metodo, "path": caminho, "body": corpo }
  m.api.control = "RUN"
end sub

sub onResposta()
  r = m.api.response
  if r = invalid then return
  ' A API recusa sessão com 401; 403 é só PIN errado (tratado na ativação).
  if r.status = 401 then
    iniciar()
    return
  end if
  if m.fase = "carregando" then
    tratarLista(r)
  else if m.fase = "ativando" then
    tratarAtivacao(r)
  end if
end sub

sub tratarLista(r as Object)
  dados = invalid
  if r.status = 200 then dados = ParseJson(r.body)
  if dados = invalid or dados.profiles = invalid or dados.profiles.count() = 0 then
    m.top.findNode("mensagem").text = "Não foi possível carregar os perfis. Abra o app de novo."
    return
  end if
  m.perfis = dados.profiles
  m.top.findNode("mensagem").text = ""
  m.fase = "perfis"
  desenharPerfis()
  atualizarFoco()
end sub

sub desenharPerfis()
  grupo = m.top.findNode("perfis")
  grupo.removeChildrenIndex(grupo.getChildCount(), 0)
  m.cartoes = []
  total = m.perfis.count()
  larg = 260 ' largura de cada cartão, com 60 de respiro
  passo = larg + 60
  x0 = int((1920 - (total * passo - 60)) / 2)
  for i = 0 to total - 1
    perfil = m.perfis[i]
    cartao = CreateObject("roSGNode", "Group")
    cartao.translation = [x0 + i * passo, 420]
    cartao.scaleRotateCenter = [130, 150]

    anel = CreateObject("roSGNode", "Rectangle")
    anel.width = 260
    anel.height = 260
    anel.translation = [0, 0]
    anel.color = "0x91c48a00"
    cartao.appendChild(anel)

    avatar = CreateObject("roSGNode", "Rectangle")
    avatar.width = 240
    avatar.height = 240
    avatar.translation = [10, 10]
    avatar.color = "0x527f4dff"
    cartao.appendChild(avatar)

    inicial = CreateObject("roSGNode", "Label")
    inicial.width = 240
    inicial.height = 240
    inicial.translation = [10, 10]
    inicial.horizAlign = "center"
    inicial.vertAlign = "center"
    inicial.text = UCase(Left(perfil.name, 1))
    inicial.color = "0xffffffff"
    cartao.appendChild(inicial)

    nome = CreateObject("roSGNode", "Label")
    nome.width = 260
    nome.height = 50
    nome.translation = [0, 275]
    nome.horizAlign = "center"
    nome.text = perfil.name
    nome.color = "0xc9d0caff"
    cartao.appendChild(nome)

    if perfil.hasPin = true then
      pin = CreateObject("roSGNode", "Label")
      pin.width = 260
      pin.height = 40
      pin.translation = [0, 322]
      pin.horizAlign = "center"
      pin.text = "protegido por PIN"
      pin.color = "0x9ca3afff"
      cartao.appendChild(pin)
    end if

    grupo.appendChild(cartao)
    m.cartoes.push({ "grupo": cartao, "anel": anel, "nome": nome })
  end for
end sub

sub atualizarFoco()
  for i = 0 to m.cartoes.count() - 1
    c = m.cartoes[i]
    if i = m.indice then
      c.anel.color = "0x91c48aff"
      c.grupo.scale = [1.1, 1.1]
      c.nome.color = "0xffffffff"
    else
      c.anel.color = "0x91c48a00"
      c.grupo.scale = [1, 1]
      c.nome.color = "0xc9d0caff"
    end if
  end for
end sub

function onKeyEvent(tecla as String, pressionada as Boolean) as Boolean
  if not pressionada or m.fase <> "perfis" then return false
  if tecla = "right" and m.indice < m.cartoes.count() - 1 then
    m.indice = m.indice + 1
    atualizarFoco()
    return true
  else if tecla = "left" and m.indice > 0 then
    m.indice = m.indice - 1
    atualizarFoco()
    return true
  else if tecla = "OK" then
    escolher(m.perfis[m.indice], "")
    return true
  end if
  return false
end function

sub escolher(perfil as Object, pin as String)
  m.pendente = perfil
  if perfil.hasPin = true and pin = "" then
    abrirPin("Digite o PIN de " + perfil.name)
    return
  end if
  m.fase = "ativando"
  corpo = "{}"
  if pin <> "" then corpo = FormatJson({ "pin": pin })
  pedir("POST", "/v1/profiles/" + perfil.id + "/activate", corpo)
end sub

sub abrirPin(mensagem as String)
  m.fase = "pin"
  dialogo = CreateObject("roSGNode", "PinDialog")
  dialogo.title = "PIN do perfil"
  dialogo.message = mensagem
  dialogo.pinLength = 4
  dialogo.buttons = ["OK", "Cancelar"]
  dialogo.observeField("buttonSelected", "onPinBotao")
  m.dialogoPin = dialogo
  m.top.getScene().dialog = dialogo
end sub

sub onPinBotao()
  indice = m.dialogoPin.buttonSelected
  pin = m.dialogoPin.pin
  m.top.getScene().dialog = invalid
  m.top.setFocus(true)
  if indice = 0 and Len(pin) = 4 then
    m.fase = "perfis"
    escolher(m.pendente, pin)
  else
    m.fase = "perfis"
  end if
end sub

sub tratarAtivacao(r as Object)
  if r.status = 204 or r.status = 200 then
    m.fase = "inicio"
    m.top.findNode("perfis").visible = false
    m.top.findNode("mensagem").visible = false
    m.top.findNode("titulo").visible = false
    m.top.findNode("ola").text = "Olá, " + m.pendente.name
    m.top.findNode("ola").visible = true
    m.top.findNode("olaInfo").visible = true
    return
  end if
  m.fase = "perfis"
  if r.status = 403 and m.pendente.hasPin = true then
    abrirPin("PIN incorreto. Tente de novo.")
  else if r.status = 401 then
    iniciar()
  else
    m.top.findNode("mensagem").text = "Não foi possível abrir o perfil. Tente de novo."
  end if
end sub
