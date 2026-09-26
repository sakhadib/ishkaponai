ISHKAPON is a AI native problem solver for school students. 

given a problem (physics, chemistry, math) ishkapon can call defined model from openrouter, using bash, powershell, any available native code running capability it runs calculations (An LLM never calculates from mind. not even 2+2. every calculations, stage by stage will be performed by shell and the responses will be returned to the model. The model will give final formatted answer.)

the system is a chat based application. where left sidebar is chat history. No authentication is needed, as this is an opensource open product.

We will use sqlite for database, and typescript for scripting. 

- the AI response can be in Bangla / Engling
- Both language has to render
- in system prompt, the usage of tools has to be clear
- the final response has to solve the problem step by step without any jump showing all calculation steps. and for this model can run as many shell commands as it wants. it can group and pipe commands as well. 
- the final response will be a markdown. and markdown has to be rendered cleanly.
- we will use roboto for english and kalpurush web font for bangla. 
- All variables / constants / numbers has to be in english letters. be clear on prompt about that. 
- model absolutely can provide equations in $inline$ and $$block$$ and we have to render them. 
- use mermaid JS if model is able to write mermaid code, it can provide it. we will render.
  
there will be copy button for each response. 

and finally, we will keep the history in sqlite. and will show them in no time if user wants. 

The context protocol should be designed as such small context models can be part of this, and also models have enough context to run and give answer. Chat progression context is absolutely must.

each chat session is completely different session with a model, and we never conflate contexts between chats. 

## RESPONSE STREAMING, thinking and executing code messages, is absolutely needed for better UI.


