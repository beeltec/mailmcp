ObjC.import('Foundation');

function run() {
  try {
    var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
    var mail = Application('com.apple.mail');
    return JSON.stringify({ ok: true, data: dispatch(mail, request) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error.message || error) });
  }
}

function resolveAccount(mail, config) {
  if (!config) throw new Error('An allowed account is required.');
  var found = mail.accounts.whose({ id: config.id })();
  if (found.length !== 1) throw new Error('Configured account is missing. Run setup again.');
  var account = found[0];
  if (!account.enabled()) throw new Error('The configured Mail account is disabled.');
  if (account.emailAddresses().indexOf(config.email) === -1) throw new Error('Configured sender no longer belongs to this account. Run setup again.');
  return account;
}

function verifySender(mail, config) {
  var owners = mail.accounts().filter(function (account) {
    return account.emailAddresses().some(function (email) { return email.toLowerCase() === config.email.toLowerCase(); });
  });
  if (owners.length !== 1 || owners[0].id() !== config.id) {
    throw new Error('Sender address is shared by multiple Mail accounts. Configure a unique sender address before composing or sending.');
  }
}

function resolveMailbox(account, path) {
  var parent = account;
  for (var i = 0; i < path.length; i++) {
    var matches = parent.mailboxes.whose({ name: path[i] })();
    if (matches.length !== 1) throw new Error('Mailbox path ' + JSON.stringify(path) + ' is missing or ambiguous. Use an exact path returned by list_mailboxes; do not translate mailbox names.');
    parent = matches[0];
  }
  if (parent.account().id() !== account.id()) throw new Error('Mailbox is outside the allowed account.');
  return parent;
}

function resolveMessage(account, ref) {
  var mailbox = resolveMailbox(account, ref.mailbox);
  var message = mailbox.messages.byId(ref.id);
  if (!message.exists() || message.messageId() !== ref.messageId) {
    throw new Error('Message reference is stale. Search its mailbox again.');
  }
  return message;
}

function mailboxList(account) {
  var result = [];
  function visit(parent, path) {
    if (path.length > 30) throw new Error('Mailbox nesting exceeds the supported depth.');
    var children = parent.mailboxes();
    for (var i = 0; i < children.length; i++) {
      if (result.length >= 1000) throw new Error('Account has more than 1000 mailboxes.');
      var child = children[i];
      var next = path.concat(child.name());
      result.push({ path: next, unread: child.unreadCount() });
      visit(child, next);
    }
  }
  visit(account, []);
  return result;
}

function summary(message, path) {
  return {
    ref: { mailbox: path, id: message.id(), messageId: message.messageId() },
    subject: message.subject(), sender: message.sender(),
    receivedAt: message.dateReceived().toISOString(),
    read: message.readStatus(), flag: message.flagIndex(),
  };
}

function recipients(collection) {
  return collection.address();
}

function searchMessages(mailbox, args) {
  var ids = mailbox.messages.id();
  var dates = mailbox.messages.dateReceived();
  var senders = mailbox.messages.sender();
  var subjects = mailbox.messages.subject();
  var states = mailbox.messages.readStatus();
  var flags = mailbox.messages.flagIndex();
  var after = mailbox.messages.id();
  if (JSON.stringify(ids) !== JSON.stringify(after) || dates.length !== ids.length
    || senders.length !== ids.length || subjects.length !== ids.length
    || states.length !== ids.length || flags.length !== ids.length) {
    throw new Error('Mailbox changed during search. Retry the read-only search from offset 0.');
  }
  var since = args.since ? new Date(args.since).getTime() : null;
  var before = args.before ? new Date(args.before).getTime() : null;
  var matches = [];
  for (var i = 0; i < ids.length; i++) {
    var date = dates[i].getTime();
    if (since !== null && date < since) continue;
    if (before !== null && date >= before) continue;
    if (args.sender && senders[i].toLowerCase().indexOf(args.sender.toLowerCase()) === -1) continue;
    if (args.subject && subjects[i].toLowerCase().indexOf(args.subject.toLowerCase()) === -1) continue;
    if (args.unread !== undefined && states[i] === args.unread) continue;
    if (args.recipient) {
      var message = mailbox.messages.byId(ids[i]);
      var addresses = recipients(message.toRecipients).concat(recipients(message.ccRecipients), recipients(message.bccRecipients));
      if (!addresses.some(function (address) { return address.toLowerCase().indexOf(args.recipient.toLowerCase()) !== -1; })) continue;
    }
    matches.push({ id: ids[i], date: date, index: i });
  }
  matches.sort(function (a, b) { return b.date - a.date || b.id - a.id; });
  var start = Math.min(args.offset, matches.length);
  var end = Math.min(start + args.limit, matches.length);
  var results = matches.slice(start, end).map(function (match) {
    var index = match.index;
    return { ref: { mailbox: args.mailbox, id: match.id, messageId: mailbox.messages.byId(match.id).messageId() },
      subject: subjects[index], sender: senders[index], receivedAt: dates[index].toISOString(),
      read: states[index], flag: flags[index] };
  });
  return { messages: results, scanned: ids.length, total: ids.length, matched: matches.length,
    offset: start, limit: args.limit, nextOffset: end < matches.length ? end : null,
    note: 'Searched the whole mailbox. Results are newest first. Offset counts matching messages. Follow nextOffset with unchanged filters. Restart at offset 0 if mail changes.' };
}

function outgoing(mail, id, email) {
  var matches = mail.outgoingMessages.whose({ id: id })();
  if (matches.length !== 1) throw new Error('Draft is no longer open in Mail. Create a new draft or finish it in Mail.');
  var draft = matches[0];
  if (mail.extractAddressFrom(draft.sender()).toLowerCase() !== email.toLowerCase()) {
    throw new Error('Draft sender changed. It no longer matches the selected account.');
  }
  return draft;
}

function draftInfo(draft) {
  return {
    id: draft.id(), sender: draft.sender(), subject: draft.subject(),
    body: normalizedBody(draft.content()),
    to: recipients(draft.toRecipients), cc: recipients(draft.ccRecipients), bcc: recipients(draft.bccRecipients),
  };
}

function normalizedBody(text) {
  return text.replace(/\uFFFC/g, '').replace(/\s+$/, '');
}

function setRecipients(mail, draft, args) {
  var types = [ ['to', 'toRecipients', 'ToRecipient'], ['cc', 'ccRecipients', 'CcRecipient'], ['bcc', 'bccRecipients', 'BccRecipient'] ];
  types.forEach(function (type) {
    var addresses = args[type[0]] || [];
    addresses.forEach(function (address) { draft[type[1]].push(mail[type[2]]({ address: address })); });
  });
}

function dispatch(mail, request) {
  var args = request.args;
  if (request.operation === 'discover_accounts') {
    return mail.accounts().map(function (account) {
      return { id: account.id(), name: account.name(), emails: account.emailAddresses() };
    });
  }
  var account = resolveAccount(mail, request.account);
  if (['create_draft', 'get_draft', 'add_attachment', 'send_draft'].indexOf(request.operation) !== -1) {
    verifySender(mail, request.account);
  }
  switch (request.operation) {
    case 'account_info':
      return { id: account.id(), name: account.name(), email: request.account.email, trash: request.account.trash };
    case 'list_mailboxes':
      return mailboxList(account);
    case 'search_messages': {
      var mailbox = resolveMailbox(account, args.mailbox);
      return searchMessages(mailbox, args);
    }
    case 'read_message': {
      var message = resolveMessage(account, args.ref);
      var body = message.content();
      var attachments = message.mailAttachments();
      return Object.assign(summary(message, args.ref.mailbox), {
        to: recipients(message.toRecipients), cc: recipients(message.ccRecipients),
        body: body.slice(args.bodyOffset, args.bodyOffset + args.bodyLimit),
        nextBodyOffset: args.bodyOffset + args.bodyLimit < body.length ? args.bodyOffset + args.bodyLimit : null,
        attachments: attachments.map(function (attachment) {
          var mimeType = null;
          try { mimeType = attachment.mimeType(); } catch (_) {}
          return { id: attachment.id(), name: attachment.name(), mimeType: mimeType,
            size: attachment.fileSize(), downloaded: attachment.downloaded() };
        }),
      });
    }
    case 'set_message_state': {
      var message = resolveMessage(account, args.ref);
      if (args.read !== undefined) message.readStatus = args.read;
      if (args.flag !== undefined) message.flagIndex = args.flag;
      return summary(message, args.ref.mailbox);
    }
    case 'move_message':
    case 'trash_message': {
      var message = resolveMessage(account, args.ref);
      var path = request.operation === 'trash_message' ? request.account.trash : args.destination;
      var destination = resolveMailbox(account, path);
      if (JSON.stringify(path) === JSON.stringify(args.ref.mailbox)) return { moved: false, reason: 'Already in destination.' };
      mail.move(message, { to: destination });
      return { moved: true, destination: path, messageId: args.ref.messageId, note: 'Search the destination to obtain a new message reference.' };
    }
    case 'save_attachment': {
      var message = resolveMessage(account, args.ref);
      var matches = message.mailAttachments.whose({ id: args.attachmentId })();
      if (matches.length !== 1) throw new Error('Attachment is missing or ambiguous. Read the message again.');
      if (!matches[0].downloaded()) throw new Error('Download the attachment in Mail first, then retry.');
      mail.save(matches[0], { in: Path(args.destination) });
      return { saved: true };
    }
    case 'create_draft': {
      var draft;
      if (args.kind === 'new') {
        draft = mail.OutgoingMessage({ sender: request.account.email, subject: args.subject, content: args.body, visible: true });
        mail.outgoingMessages.push(draft);
        setRecipients(mail, draft, args);
      } else {
        var original = resolveMessage(account, args.ref);
        draft = args.kind === 'reply'
          ? mail.reply(original, { openingWindow: false, replyToAll: args.replyAll })
          : mail.forward(original, { openingWindow: false });
        draft.properties = { sender: request.account.email,
          content: args.body + '\n\nFrom: ' + original.sender() + '\nSubject: ' + original.subject()
            + '\n\n' + original.content().slice(0, 100000) };
        if (args.kind === 'forward') setRecipients(mail, draft, args);
        draft.visible = true;
      }
      mail.save(draft);
      if (normalizedBody(draft.content()).indexOf(normalizedBody(args.body)) !== 0) {
        throw new Error('Mail did not retain the draft body. Inspect the draft in Mail. It was not sent.');
      }
      return draftInfo(draft);
    }
    case 'get_draft':
      return draftInfo(outgoing(mail, args.id, request.account.email));
    case 'add_attachment': {
      var draft = outgoing(mail, args.id, request.account.email);
      draft.content.attachments.push(mail.Attachment({ fileName: Path(args.path) }));
      mail.save(draft);
      return draftInfo(draft);
    }
    case 'send_draft': {
      var draft = outgoing(mail, args.id, request.account.email);
      if (JSON.stringify(draftInfo(draft)) !== args.expected) throw new Error('Draft changed. Read and review it again before sending.');
      if (draft.toRecipients.length + draft.ccRecipients.length + draft.bccRecipients.length === 0) throw new Error('Draft has no recipients.');
      var accepted = mail.send(draft);
      if (!accepted) throw new Error('Mail did not accept the send. Inspect Mail before retrying.');
      return { acceptedByMail: true, delivered: 'unknown' };
    }
    default:
      throw new Error('Unknown Mail operation.');
  }
}
