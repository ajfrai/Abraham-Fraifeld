#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Jun 11 19:08:21 2019

@author: fraifeld-mba
"""

def get_siblings(n, g_from, g_to):
    siblings = []
    for i in range(len(g_from)):
        if n == g_from[i]:
            siblings.append(g_to[i])
        elif n == g_to[i]:
            siblings.append(g_from[i])
            
    return siblings

def read_edgelist(g_from,g_to):
    adj = {}
    nodes = set(g_from+g_to)
    
    for n in nodes:
        adj[n]=get_siblings(n,g_from, g_to)
        
    return adj

def dfs(adj):
    V = list(adj.keys())
    for i in V:
        stack = [i]
        discovered = [i]
        while len(stack) > 0:
            #path = []
            u = stack[0]
            #print(u)
            
            stack.remove(stack[0])
            children = adj[u]
            for v in children:
                if v in stack:
                    print( discovered)
                if v not in discovered: 
                    stack = [v] + stack  
                    discovered.append(v)
    
                
def calculate_passage(u,v,adj):
    children = adj[u]
    passage = 0
    while v not in children:
        for c in children:
            children = children + adj[c]
        passage = passage + 1
    return passage
def cycle(adj):
    V = list(adj.keys())
    for node in V:
        stack = [node]
        discovered = [node]
        while len(stack) > 0:
            #path = []
            u = stack[0]
            #print(u)

            stack.remove(stack[0])
            children = adj[u]
            for v in children:
                if v in stack:
                        return discovered
                if v not in discovered: 
                    stack = [v] + stack  
                    discovered.append(v)
                
    
def calculate_passage(u,v,adj):
    if u == v:
        return 0
    children = adj[u]
    passage = 1
    while v not in children:
        for c in children:
            children = children + adj[c]
        passage = passage + 1
    return passage
    
def findRemoteness(g_nodes, g_from, g_to):
    adj = read_edgelist(g_from,g_to)
    c = cycle(adj)
    passages = []
    final_passages = []
    for u in range(1,g_nodes+1):
        for v in c:
            passages.append(calculate_passage(u,v,adj))
        final_passages.append(min(passages))
        passages = []
    return final_passages


g_from = [1,3,6,2,1,3]
g_to = [2,4,4,3,3,5]

adj = read_edgelist(g_from, g_to)
print(findRemoteness(6,g_from,g_to))


