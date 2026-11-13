# Letters carry no List-Unsubscribe headers

Letters send no `List-Unsubscribe` or `List-Unsubscribe-Post` headers; the only way out is the cancel link in the letter body. Every reader is paying, so leaving means cancelling a plan, and a mail app or spam scanner must never do that by itself; RFC 8058 one-click would have to act without the reader's confirm. The cost is that mail apps show no unsubscribe button, and Gmail and Yahoo require one-click for senders above about 5,000 messages a day: revisit this if the list grows near that.
