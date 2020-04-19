#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon Mar  2 11:43:27 2020

@author: fraifeld-mba
"""

### From FiveThirtyEight Riddler 
### https://fivethirtyeight.com/features/can-you-flip-your-way-to-victory/

### This script assumes two things
# 1. The coins are both fair
# 2. The points are as established in the riddle
### A : -1 or 1, B: -2 or 2

import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.colors as cl
import numpy as np
from matplotlib import cm
from matplotlib.patches import Patch
from matplotlib.lines import Line2D

total_turns = 100


def p(t,s,p_dict,total_turns):
    # Returns the probability of victory at turn t with score s
    if t == total_turns:
        if s > 0:
            return {"Probability":1,"Coin":None,"PDifference":1}
        else:
            return {"Probability":0,"Coin":None,"PDifference":1}
    else:
        try:
            a = {"Probability":.5 * p_dict[t+1][s+1] + .5 * p_dict[t+1][s-1],"Coin":"A"}
            b = {"Probability":.5 * p_dict[t+1][s+2] + .5 * p_dict[t+1][s-2],"Coin":"B"}
            dif = abs(a["Probability"] - b["Probability"])
            if a["Probability"] > b["Probability"]:
                a["PDifference"]  = dif
                return a
            else:
                b["PDifference"]  = dif
                return b
        except:
            print("Tried to access a cell in p_dict that has not been filled in yet")
            

  

def fill_results_dict(total_turns):
    # Returns a dictionary of score,turn,probability of victory,coin quads for each possible score, turn pair
    results_dict = {} 
    p_dict = {}
    # this is a two layer dictionary p_dict[turns][score] = {P(score_100 > 0 | turns, score)}
    for t in range(total_turns,-1,-1):
        p_dict[t] = {}
        results_dict[t] = {}
        max_score = 2*t
        min_score = -max_score
        for s in range(max_score,min_score-1,-1):
            results_dict[t][s] = p(t,s,p_dict,total_turns)
            p_dict[t][s] = results_dict[t][s]["Probability"]
    
    return results_dict


def get_results_df(results_dict,remove_certainties=True):
    
    scores = []
    turns = []
    coins = []
    probabilities = []
    differences = []
    ## Draws a plot where the color indicates which coin should be tossed at each score-turn pair
    for t in results_dict.keys():
        for s in results_dict[t].keys():
            scores.append(s)
            turns.append(t)
            coins.append(results_dict[t][s]["Coin"])
            probabilities.append(results_dict[t][s]["Probability"])
            differences.append(results_dict[t][s]["PDifference"])
    
    coin_df_dict = {"Turn":turns,"Score":scores,"Coin":coins,"Probability":probabilities,"PDifference":differences}

    
    coin_df = pd.DataFrame.from_dict(coin_df_dict)
    
    if (remove_certainties):
        coin_df = coin_df[coin_df.Probability > 0]
        coin_df = coin_df[coin_df.Probability < 1]

    coin_df.Coin = coin_df.Coin.replace("A","red").replace("B","blue")
    
    coin_df = coin_df.dropna().reset_index(drop=True)
    
    return coin_df

def plot_probabilities(results_dict,score_range=None,remove_certainties=True,save=False):
    ## Draws a plot where the color indicates the probability of victory at each score-turn pair
    coin_df = get_results_df(results_dict,remove_certainties)
    coin_df = coin_df[coin_df.PDifference > .000005].reset_index(drop=True)
    if score_range != None:
        coin_df = coin_df[(coin_df.Score < score_range[1]) & (coin_df.Score > score_range[0]) ]
    
    fig,ax = get_fix_ax([10,10])
    color_map = cm.get_cmap('rainbow')
    lines = ax.scatter(coin_df.Turn,coin_df.Score,c = coin_df.Probability,cmap=color_map)
    
 
    plt.colorbar(lines)
    #plt.show()
    if(save):
        plt.savefig("coingame-probabilites.png")
    else:
        plt.show()
    

def get_fix_ax(size):
    fig, ax = plt.subplots(figsize=size)
    fig.suptitle('Which Coin Should You Flip?')
    ax.set_xlabel('Turn')
    ax.set_ylabel('Score')
    return fig,ax

def plot_strategy(results_dict,weight_by_p_difference=False,save=False):
    
    coin_df = get_results_df(results_dict)
    
    coin_df = coin_df[coin_df.PDifference > .000005].reset_index(drop=True)
    
    
    if weight_by_p_difference:
        colors = [list(cl.to_rgba(coin_df.loc[i,"Coin"],coin_df.loc[i,"PDifference"])) for i in range(len(coin_df))]
        for c in colors:
            c[3] = min(1,c[3] * 20)
    else:
        colors = coin_df.Coin
        
    
    fig,ax = get_fix_ax([10,10])
    lines = ax.scatter(coin_df.Turn,coin_df.Score,color = colors)
   # basic_colors = np.unique(np.array([c[0:3] for c in colors]),axis=0)
    legend = [Line2D([0], [0], marker='o', color='w', label='Flip 1 Point Coin',markerfacecolor='r',markersize=6),Line2D([0], [0], marker='o', color='w', label='Flip 2 Point Coin', markerfacecolor='b', markersize=6)]
    ax.legend(handles=legend)
    
    if(save):
        plt.savefig("coingame-strategy.png")
    else:
        plt.show()

results_dict = fill_results_dict(total_turns)
plot_strategy(results_dict,weight_by_p_difference=True,save=True)
plot_probabilities(results_dict,save=True)