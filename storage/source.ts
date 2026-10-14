class ACI_SysLog extends ACI_BaseLog {
    static channel = null;
    static lastSeq = -1;
    static getChannel() {
        if (JSUtil.nil(ACI_SysLog.channel))
            ACI_SysLog.channel = GlideChannelManager.get().getChannel("logtail");
        return ACI_SysLog.channel;
    }
    constructor(prefix) {
        super(prefix);
        ACI_SysLog.getChannel();       
        this.parsePrefix = false;
        this.syslog = gs;
    },
}
ACI_SysLog.prototype = {
    initialize: function (prefix) {
        ACI_SysLog.getChannel();
        ACI_BaseLog.prototype.initialize.call(this, prefix);
        this.parsePrefix = false;
        this.syslog = gs;
    },
    init: function () {
        this.lastSeq = ACI_SysLog.channel.getLastSequence();
        // if (ACI_SysLog.lastSeq < this.lastSeq)
        //      ACI_SysLog.lastSeq = this.lastSeq;
        ACI_BaseLog.prototype.init.call(this);
    },
    _funcMap: {
        "info": gs.log,
        "debug": gs.log,
        "warn": gs.logWarning,
        "error": gs.logError,
        "print": gs.print
    },
    loadMessages: function () {
        //if (ACI_SysLog.lastSeq > this.lastSeq)
        //    this.lastSeq = ACI_SysLog.lastSeq;
        var messages = [];
        var currSeq = ACI_SysLog.channel.getLastSequence();
        var sessionID = gs.getSessionID();
        messages = j2js(ACI_SysLog.channel.getMessages()).filter(function (cmsg) {
            return cmsg.getSequence() > this.lastSeq;
        }, this).map(function (cmsg) {
            var level = null;
            var gdt = new GlideDateTime();
            gdt.setNumericValue(cmsg.getDate());
            var msg = cmsg.getMessage() + "";
            if (msg.match(/no thrown error/gmi))
                level = "error";
            var m = msg.match(/^(\S+) ([^]*)$/);
            if (m)
                msg = m ? m[2] : msg;
            var m2 = this.parsePrefix ? msg.match(/^([^,]*?)\s*:\s(.*)$/) : null;
            var msgStr = m2 ? m2[2] : msg;
            var prefix = m2 ? m2[1] : null;
            var user = m ? m[1] : null;
            return new ACI_Message(msgStr, level, prefix, gdt, user, cmsg.getSequence());
        }, this).filter(function (msg) {
            return msg.user == sessionID;
        });
        this.lastSeq = currSeq;
        //if (currSeq > ACI_SysLog.lastSeq)
        //    ACI_SysLog.lastSeq = currSeq;
        messages.sort(function (a, b) {
            return a.id - b.id;
        });
        return messages;
    },
    _getSysLog: function () {
        // var messages = [];
        gr = new GlideRecord('syslog');
        gr.addQuery('sys_created_on', '>=', startTime);
        gr.addQuery('sys_created_by', gs.getUserName());
        //.addOrCondition('sys_created_by', '=', 'system');
        //gr.orderBy('sys_created_on');  	
        gr.addQuery("source", "!=", "com.glide.ui.ServletErrorListener");
        gr.query();
        while (gr.next()) {
            this.msgs.push(new ACI_Message(gr.message.toString(), gr.level.getDisplayValue().toLowerCase(), gr.source.toString(), gr.sys_created_on.getGlideObject(), gr.sys_created_by.toString(), gr.getRecordClassName() + ":" + gr.sys_id));
        }
        return this.msgs;
    },
    flushMessage: function (msg, prefix, doFormat, parseRecords) {
        var ret = this.msgToString(msg, prefix);
        if (JSUtil.nil(ret))
            return "";
        if (parseRecords)
            ret = ACI_MessageLog.parseRecords(ret, (doFormat ? ACI_MessageLog.getRecordUrl : ACI_MessageLog.getDisplayName));
        if (doFormat) {
            ret = ret.replaceAll("[code]", "").replaceAll("[/code]", "");
            ret = ACI_BaseLog.replaceAll(/&#(\d+);/gm, ret, function (str, m) {
                return str.replaceAll(m[0], String.fromCharCode(m[1]));
            });
            ret = ret.replace(/<pre.*?>([^]*?)<\/pre>/gmi, '$1');
            var regex = /\n(----)*\t/gm;
            while ((m = regex.exec(ret)) !== null) {
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }
                ret = ret.replace(regex, '\n$1----');
            }
            ret = SNC.GlideHTMLSanitizer.sanitize(ret) + "";
        }
        return ret;
    },
    type: 'ACI_SysLog'
};
